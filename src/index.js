import express from 'express';
import { loadConfig, getActiveProvider } from './config.js';
import { convertResponsesToChatRequest, convertChatToResponsesOutput, parseChatSSELine, sanitizeMessages, buildFinishEventsIfNeeded } from './proxy.js';
import { appendLog, buildLogEntry, patchLog } from './logger.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

function resolveAuth(provider, req) {
  if (provider.apiKey) {
    // apiKeyHeader lets providers like Azure use "api-key" instead of "Authorization: Bearer"
    if (provider.apiKeyHeader) return null;
    return `Bearer ${provider.apiKey}`;
  }
  return req.headers.authorization || null;
}

function applyAuth(headers, provider, req) {
  if (provider.apiKey && provider.apiKeyHeader) {
    headers[provider.apiKeyHeader] = provider.apiKey;
    return;
  }
  const auth = resolveAuth(provider, req);
  if (auth) headers['Authorization'] = auth;
  else if (!provider.apiKey) {
    // Pass through client's Authorization header unchanged
    const clientAuth = req.headers.authorization;
    if (clientAuth) headers['Authorization'] = clientAuth;
  }
}

const SKIP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'content-length']);

// #15: strip trailing /v1 (and variants) so we never produce /v1/v1/...
// #7: guard against missing/non-string baseUrl
function baseUrl(provider) {
  if (!provider?.baseUrl || typeof provider.baseUrl !== 'string') {
    throw new Error(`Provider "${provider?.name}" has no baseUrl`);
  }
  // Strip trailing /v1 and trailing slash to avoid double-slash in path construction
  return provider.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

app.get('/health', (req, res) => {
  try {
    const provider = getActiveProvider();
    res.json({ status: 'ok', activeProvider: provider.name, baseUrl: provider.baseUrl });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

app.get('/v1/models', async (req, res) => {
  let provider, url;
  try {
    provider = getActiveProvider();
    const urlObj = new URL(`${baseUrl(provider)}/v1/models`);
    for (const [k, v] of Object.entries(req.query)) urlObj.searchParams.set(k, v);
    url = urlObj.toString();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
  try {
    const fetchHeaders = {};
    applyAuth(fetchHeaders, provider, req);
    const upstream = await fetch(url, {
      headers: fetchHeaders
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      appendLog(buildLogEntry({ url, reqBody: null, resStatus: upstream.status, resBody: data }));
      res.status(upstream.status).json(data);
    } else {
      const text = await upstream.text();
      appendLog(buildLogEntry({ url, reqBody: null, resStatus: upstream.status, resBody: text }));
      res.status(upstream.status).type('text').send(text);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

// /v1/chat/completions — passthrough with content type normalization
app.post('/v1/chat/completions', async (req, res) => {
  let provider, url;
  try {
    provider = getActiveProvider();
    url = new URL(`${baseUrl(provider)}/v1/chat/completions`);
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);

  if (!Array.isArray(req.body?.messages)) {
    return res.status(400).json({ error: '"messages" must be an array' });
  }

  const body = { ...req.body, messages: sanitizeMessages(req.body.messages) };

  const isStream = !!body.stream;

  try {
    const chatCompHeaders = { 'Content-Type': 'application/json' };
    applyAuth(chatCompHeaders, provider, req);
    const upstream = await fetch(url.toString(), {
      method: 'POST',
      headers: chatCompHeaders,
      body: JSON.stringify(body)
    });

    const logTs = appendLog(buildLogEntry({ url: url.toString(), reqBody: body, resStatus: upstream.status, stream: isStream }));
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!SKIP_HEADERS.has(key)) res.setHeader(key, value);
    });
    // #3: guard against null body (e.g. 204 No Content)
    if (!upstream.body) { res.end(); patchLog(logTs, { resBody: '' }); return; }
    const isJson = (upstream.headers.get('content-type') || '').includes('application/json');
    const decoder = new TextDecoder();
    let rawText = '';
    const LOG_CAP = 1 * 1024 * 1024; // 1 MB cap to avoid unbounded accumulation on long streams
    await upstream.body.pipeTo(new WritableStream({
      write(chunk) { if (rawText.length < LOG_CAP) rawText += decoder.decode(chunk, { stream: true }); res.write(chunk); },
      // #4: log structured JSON for non-stream JSON responses; fall back to raw string
      close() {
        res.end();
        // flush any multi-byte sequence held in the decoder's internal buffer
        if (rawText.length < LOG_CAP) rawText += decoder.decode();
        let logBody = rawText;
        if (!isStream && isJson) { try { logBody = JSON.parse(rawText); } catch {} }
        patchLog(logTs, { resBody: logBody });
      }
    }));
  } catch (err) {
    // #5: always terminate the response so clients don't hang
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

// /v1/responses — passthrough if provider supports Responses API natively,
// otherwise convert Responses→Chat, forward, convert Chat→Responses back
app.post('/v1/responses', async (req, res) => {
  let provider;
  try {
    provider = getActiveProvider();
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  if (provider.responsesPassthrough) {
    // #6: use actual stream flag from request body
    const isStream = !!req.body?.stream;
    try {
      const url = new URL(`${baseUrl(provider)}/v1/responses`);
      for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
      const passthroughHeaders = { 'Content-Type': 'application/json' };
      applyAuth(passthroughHeaders, provider, req);
      const upstream = await fetch(url.toString(), {
        method: 'POST',
        headers: passthroughHeaders,
        body: JSON.stringify(req.body)
      });
      const logTs = appendLog(buildLogEntry({ url: url.toString(), reqBody: req.body, resStatus: upstream.status, stream: isStream }));
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!SKIP_HEADERS.has(key)) res.setHeader(key, value);
      });
      // #3: guard against null body (e.g. 204 No Content)
      if (!upstream.body) { res.end(); patchLog(logTs, { resBody: '' }); return; }
      const decoder = new TextDecoder();
      let rawText = '';
      const LOG_CAP = 1 * 1024 * 1024;
      await upstream.body.pipeTo(new WritableStream({
        write(chunk) {
          if (!isStream && rawText.length < LOG_CAP) rawText += decoder.decode(chunk, { stream: true });
          res.write(chunk);
        },
        close() {
          res.end();
          if (!isStream) {
            rawText += decoder.decode();
            patchLog(logTs, { resBody: rawText });
          }
        }
      }));
    } catch (err) {
      // #5: always terminate the response
      if (!res.headersSent) res.status(502).json({ error: err.message });
      else res.end();
    }
    return;
  }

  const chatBody = convertResponsesToChatRequest(req.body);
  const isStream = req.body.stream === true;

  // Hoist state so the catch block can reference it for response.failed events
  const state = {};

  try {
    // #2: forward query parameters to upstream (e.g. api-version for Azure-style gateways)
    const chatUrlObj = new URL(`${baseUrl(provider)}/v1/chat/completions`);
    for (const [k, v] of Object.entries(req.query)) chatUrlObj.searchParams.set(k, v);
    const chatUrl = chatUrlObj.toString();

    const chatHeaders = { 'Content-Type': 'application/json' };
    applyAuth(chatHeaders, provider, req);
    const upstream = await fetch(chatUrl, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({ ...chatBody, stream: isStream })
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      appendLog(buildLogEntry({ url: chatUrl, reqBody: chatBody, resStatus: upstream.status, resBody: errBody }));
      // forward the upstream content-type so JSON error bodies aren't misinterpreted as plain text
      const errCt = upstream.headers.get('content-type');
      if (errCt) res.setHeader('Content-Type', errCt);
      return res.status(upstream.status).send(errBody);
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const logTs = appendLog(buildLogEntry({ url: chatUrl, reqBody: chatBody, resStatus: upstream.status, stream: true }));
      const decoder = new TextDecoder();
      let buffer = '';
      let collectedText = '';
      // #3: track whether the upstream stream ended cleanly (received [DONE])
      let streamDone = false;

      const writeEvents = (events) => {
        for (const e of events) {
          res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
          // #6: only collect text deltas for the log — skip function_call_arguments.delta
          if (e.event === 'response.output_text.delta' && e.data?.delta) collectedText += e.data.delta;
        }
      };

      if (!upstream.body) {
        res.write('data: [DONE]\n\n');
        res.end();
        patchLog(logTs, { resBody: '' });
        return;
      }

      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE events are separated by blank lines. Normalise \r\n to \n first so both
        // \n\n and \r\n\r\n (common in HTTP/1.1 responses) are handled correctly.
        const normalised = buffer.replace(/\r\n/g, '\n');
        const parts = normalised.split('\n\n');
        buffer = parts.pop(); // last part may be incomplete

        for (const part of parts) {
          // Per SSE spec, multiple data: lines in one event are joined with \n
          const dataLines = part.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          const line = `data: ${dataLines.join('\n')}`;
          const parsed = parseChatSSELine(line, state);
          if (!parsed) continue;
          if (parsed.done) {
            streamDone = true;
            const finishEvents = buildFinishEventsIfNeeded(state);
            if (finishEvents) writeEvents(finishEvents);
            res.write('data: [DONE]\n\n');
          } else if (parsed.multi) {
            writeEvents(parsed.multi);
          } else {
            res.write(`event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`);
            if (parsed.event === 'response.output_text.delta' && parsed.data?.delta) collectedText += parsed.data.delta;
          }
        }
      }

      // flush any remaining buffered bytes after the loop ends
      if (buffer.trim()) {
        const normalised = buffer.replace(/\r\n/g, '\n');
        const dataLines = normalised.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart());
        if (dataLines.length) {
          const parsed = parseChatSSELine(`data: ${dataLines.join('\n')}`, state);
          if (parsed?.multi) writeEvents(parsed.multi);
          else if (parsed?.done) {
            streamDone = true;
            const finishEvents = buildFinishEventsIfNeeded(state);
            if (finishEvents) writeEvents(finishEvents);
            res.write('data: [DONE]\n\n');
          }
        }
      }

      if (!streamDone) {
        // Stream ended without [DONE]. If we already received a finish_reason, treat it as a
        // normal completion — the upstream just omitted the [DONE] sentinel.
        // Only emit response.failed when there was truly no finish signal at all.
        if (!state.finishEmitted && state.id) {
          const finishEvents = buildFinishEventsIfNeeded(state, { requireFinishReason: true });
          if (finishEvents) {
            writeEvents(finishEvents);
          } else {
            const failedEvent = { type: 'response.failed', response: { id: state.id, object: 'response', created_at: state.createdAt, model: state.model, status: 'failed', error: { message: 'upstream stream ended without [DONE]' } } };
            res.write(`event: response.failed\ndata: ${JSON.stringify(failedEvent)}\n\n`);
            state.finishEmitted = true;
          }
        }
        res.write('data: [DONE]\n\n');
      }

      res.end();
      patchLog(logTs, { resBody: collectedText });
    } else {
      // check content-type before calling .json() to handle 2xx non-JSON responses
      const contentType = upstream.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await upstream.text();
        appendLog(buildLogEntry({ url: chatUrl, reqBody: chatBody, resStatus: upstream.status, resBody: text }));
        return res.status(upstream.status).type('text').send(text);
      }
      const chatResp = await upstream.json();
      const responsesResp = convertChatToResponsesOutput(chatResp);
      appendLog(buildLogEntry({ url: chatUrl, reqBody: chatBody, resStatus: upstream.status, resBody: responsesResp }));
      res.json(responsesResp);
    }
  } catch (err) {
    // #5: always terminate the response
    if (!res.headersSent) {
      res.status(502).json({ error: err.message });
    } else {
      // Stream already started — send a response.failed event so clients don't hang
      if (state && state.id) {
        const failedEvent = { type: 'response.failed', response: { id: state.id, object: 'response', created_at: state.createdAt, model: state.model, status: 'failed', error: { message: err.message } } };
        res.write(`event: response.failed\ndata: ${JSON.stringify(failedEvent)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    }
  }
});

const cfg = loadConfig();
const port = cfg.port || 18188;
app.listen(port, '127.0.0.1', () => {
  console.log(`[proxy] listening on http://localhost:${port}`);
});
