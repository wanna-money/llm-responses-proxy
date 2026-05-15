export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  const result = [];
  for (const item of messages) {
    if (Array.isArray(item.content)) {
      const mapped = item.content.flatMap(c => {
        if (c.type === 'input_text') return [{ type: 'text', text: c.text ?? '' }];
        if (c.type === 'output_text') return [{ type: 'text', text: c.text ?? '' }];
        if (c.type === 'input_image') {
          // #7: support both image_url and file_id input forms; file_id has no Chat equivalent
          if (c.image_url) {
            const out = { type: 'image_url', image_url: { url: c.image_url } };
            if (c.detail) out.image_url.detail = c.detail;
            return [out];
          }
          process.stdout.write(`[proxy] input_image with file_id is not supported in Chat Completions — skipped\n`);
          return [];
        }
        // #2: unknown Responses content part types have no Chat Completions equivalent — skip to avoid upstream 400
        if (c.type && c.type !== 'text' && c.type !== 'image_url') {
          process.stdout.write(`[proxy] content part type "${String(c.type).replace(/\n/g, '\\n')}" is not supported in Chat Completions — skipped\n`);
          return [];
        }
        // normalise shorthand { type:"image_url", image_url:"https://..." } → { image_url:{ url } }
        if (c.type === 'image_url' && typeof c.image_url === 'string') {
          return [{ type: 'image_url', image_url: { url: c.image_url } }];
        }
        return [c];
      });
      // #3: if all content parts were unsupported and mapped to nothing, fall back to empty string
      // to avoid sending content:[] which Chat Completions rejects for most roles.
      // Exception: assistant messages with tool_calls must be preserved — content:null is valid there.
      if (!mapped.length) {
        if (item.role === 'assistant' && item.tool_calls?.length) {
          result.push({ ...item, content: null });
        } else if (item.role === 'assistant') {
          continue; // assistant with no content and no tool_calls can be dropped
        } else {
          result.push({ ...item, content: '' });
        }
        continue;
      }
      result.push({ ...item, content: mapped });
      continue;
    }
    result.push(item);
  }
  return result;
}

// Responses-API-only fields that must not be forwarded to Chat Completions
const RESPONSES_ONLY_FIELDS = new Set([
  'instructions', 'previous_response_id', 'reasoning', 'metadata',
  'store', 'truncation', 'include', 'background', 'conversation',
  'prompt_cache_key', 'client_metadata',
  // Responses-only media/modality fields — Chat Completions uses different semantics
  'modalities', 'audio',
]);

// Chat Completions requires that every tool_call_id in an assistant message is immediately
// followed by a matching tool message — no other role may appear in between.
// Responses API allows arbitrary messages between a function_call and its function_call_output,
// so we reorder: any non-tool messages that are sandwiched between an assistant(tool_calls) and
// its tool replies are moved to just before the assistant message.
function reorderToolMessages(messages) {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Collect the set of call ids this assistant message expects responses for
      const pendingIds = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));
      // Lookahead: gather all tool messages that answer these call ids, and any
      // non-tool messages that appear between them.
      const toolReplies = [];
      const interleavedNonTool = [];
      let j = i + 1;
      while (j < messages.length && pendingIds.size > 0) {
        const next = messages[j];
        if (next.role === 'tool' && next.tool_call_id && pendingIds.has(next.tool_call_id)) {
          toolReplies.push(next);
          pendingIds.delete(next.tool_call_id);
          j++;
        } else if (next.role !== 'tool') {
          // Non-tool message interspersed — collect it, keep scanning for tool replies
          interleavedNonTool.push(next);
          j++;
        } else {
          // tool message for a different (later) assistant — stop
          break;
        }
      }
      if (interleavedNonTool.length && toolReplies.length) {
        // Move the interleaved non-tool messages to before the assistant message
        process.stdout.write(`[proxy] moved ${interleavedNonTool.length} non-tool message(s) before assistant tool_calls block to satisfy Chat Completions ordering\n`);
        out.push(...interleavedNonTool);
      }
      out.push(msg);
      out.push(...toolReplies);
      // If no tool replies were found, interleavedNonTool was never pushed — emit now to avoid silent drop.
      if (!toolReplies.length && interleavedNonTool.length) {
        out.push(...interleavedNonTool);
      }
      i = j;
    } else {
      out.push(msg);
      i++;
    }
  }
  return out;
}

// Converts a Responses API request body to Chat Completions format
export function convertResponsesToChatRequest(req) {
  const { input, max_output_tokens, tools, text, instructions, tool_choice, parallel_tool_calls, ...rest } = req;

  const result = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!RESPONSES_ONLY_FIELDS.has(k)) result[k] = v;
  }

  const chatMessages = [];

  if (instructions) {
    chatMessages.push({ role: 'system', content: instructions });
  }

  if (input !== undefined) {
    if (!Array.isArray(input) && typeof input !== 'string') {
      process.stdout.write(`[proxy] input must be a string or array — got ${typeof input}, treating as empty\n`);
    } else {
      const inputArr = typeof input === 'string'
        ? [{ role: 'user', content: input }]
        : (input || []);

      // Pre-pass 1: collect call_ids for ALL valid function_call sources in this input array,
      // including:
      //   (a) function_call items (current-turn tool calls)
      //   (b) assistant messages with tool_calls (prior-turn context carried forward)
      //   (c) assistant messages with function_call content parts
      // This ensures function_call_output items are never dropped even when the corresponding
      // function_call appeared in a prior turn or later in the same array.
      const skippedCallIds = new Set(); // call_ids whose function_call was invalid (missing name/id)
      const knownCallIds = new Set();   // all valid call_ids seen anywhere in the input
      for (const item of inputArr) {
        if (item.type === 'function_call') {
          const id = item.call_id || item.id;
          if (id && item.name) knownCallIds.add(id);
          else if (id) skippedCallIds.add(id); // invalid — will skip paired output too
        } else if ((item.type === 'message' || item.role) && item.role === 'assistant') {
          // Prior-turn context: assistant messages with tool_calls
          if (Array.isArray(item.tool_calls)) {
            for (const tc of item.tool_calls) {
              const id = tc.id || tc.call_id;
              const name = tc.name || tc.function?.name;
              if (id && name) knownCallIds.add(id);
            }
          }
          // Prior-turn context: inline function_call content parts
          if (Array.isArray(item.content)) {
            for (const p of item.content) {
              if (p.type === 'function_call') {
                const id = p.id || p.call_id;
                if (id && p.name) knownCallIds.add(id);
              }
            }
          }
        }
      }

      // emittedCallIds tracks call_ids whose assistant tool_calls message has already been
      // pushed to chatMessages. function_call_output items are deferred until this set contains
      // their call_id so the tool message always follows the assistant message.
      const emittedCallIds = new Set();
      // Deferred function_call_output items: Map<call_id, tool-message> for outputs whose
      // function_call has not yet been emitted (appears later in the same array).
      const deferredOutputs = new Map();

      // Helper: flush any deferred outputs whose call_ids are now in emittedCallIds.
      // Called after every assistant tool_calls push to preserve correct ordering.
      const flushDeferred = (callIds) => {
        for (const callId of callIds) {
          const deferred = deferredOutputs.get(callId);
          if (deferred) {
            chatMessages.push(deferred);
            deferredOutputs.delete(callId);
          }
        }
      };

      for (const item of inputArr) {
        if (item.type === 'function_call_output') {
          const toolCallId = item.call_id || item.id;
          if (!toolCallId) {
            process.stdout.write(`[proxy] function_call_output missing call_id/id — skipped\n`);
            continue;
          }
          if (skippedCallIds.has(toolCallId)) {
            process.stdout.write(`[proxy] function_call_output for skipped call_id "${String(toolCallId).replace(/\n/g, '\\n')}" — skipped\n`);
            continue;
          }
          if (!knownCallIds.has(toolCallId)) {
            process.stdout.write(`[proxy] function_call_output for unknown call_id "${String(toolCallId).replace(/\n/g, '\\n')}" — skipped\n`);
            continue;
          }
          const toolMsg = { role: 'tool', tool_call_id: toolCallId, content: item.output ?? '' };
          if (emittedCallIds.has(toolCallId)) {
            // Matching assistant tool_calls already emitted — can push immediately.
            chatMessages.push(toolMsg);
          } else {
            // function_call appears later in the array (or is a prior-turn assistant message
            // not yet processed). Defer and flush after the assistant message is emitted.
            deferredOutputs.set(toolCallId, toolMsg);
          }
          continue;
        }
        if (item.type === 'function_call') {
          const callId = item.call_id || item.id;
          if (!callId) {
            process.stdout.write(`[proxy] function_call missing call_id/id — skipped\n`);
            continue;
          }
          if (!item.name) {
            process.stdout.write(`[proxy] function_call missing name — skipped\n`);
            skippedCallIds.add(callId);
            continue;
          }
          const prev = chatMessages[chatMessages.length - 1];
          const toolCall = {
            id: callId,
            type: 'function',
            function: { name: item.name, arguments: item.arguments || '' }
          };
          if (prev?.role === 'assistant' && !prev.content) {
            prev.tool_calls = prev.tool_calls || [];
            prev.tool_calls.push(toolCall);
          } else {
            chatMessages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
          }
          emittedCallIds.add(callId);
          flushDeferred([callId]);
          continue;
        }
        if (item.type === 'message' || item.role) {
          const { type, ...msg } = item;
          if (msg.role === 'developer') msg.role = 'system';
          // content:null is only valid for assistant when tool_calls are also present
          if (msg.content === null) {
            if (msg.role !== 'assistant' || !msg.tool_calls?.length) msg.content = '';
          }
          // Responses API assistant messages may carry tool_calls with call_id instead of id.
          // Convert to Chat Completions format so tool_call_id in following tool messages matches.
          if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            const converted = [];
            for (const tc of msg.tool_calls) {
              // Already Chat format (has id field and type=function) — validate and keep
              if (tc.id && tc.type === 'function') {
                if (!tc.function?.name) {
                  process.stdout.write(`[proxy] assistant tool_call missing function name — skipped\n`);
                  continue;
                }
                emittedCallIds.add(tc.id);
                converted.push(tc);
                continue;
              }
              // Responses format: { call_id, name, arguments } or similar
              const id = tc.id || tc.call_id;
              const name = tc.name || tc.function?.name || '';
              if (!id) {
                process.stdout.write(`[proxy] assistant tool_call missing id/call_id — skipped\n`);
                continue;
              }
              if (!name) {
                process.stdout.write(`[proxy] assistant tool_call missing name — skipped\n`);
                continue;
              }
              emittedCallIds.add(id);
              converted.push({
                id,
                type: 'function',
                function: { name, arguments: tc.arguments || tc.function?.arguments || '' }
              });
            }
            if (converted.length) {
              msg.tool_calls = converted;
            } else {
              delete msg.tool_calls;
              // tool_calls all filtered — content:null is now invalid, set empty string
              if (msg.content === null) msg.content = '';
            }
          }
          // Responses API assistant messages may also encode tool calls as content array items
          // with type 'function_call'. Convert these to tool_calls so Chat Completions accepts them.
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            const functionCallParts = msg.content.filter(p => p.type === 'function_call');
            if (functionCallParts.length) {
              const existingIds = new Set((msg.tool_calls || []).map(tc => tc.id || tc.call_id));
              const newToolCalls = functionCallParts
                .filter(p => {
                  const id = p.id || p.call_id;
                  return id && p.name && !existingIds.has(id);
                })
                .map(p => {
                  const id = p.id || p.call_id;
                  emittedCallIds.add(id);
                  return { id, type: 'function', function: { name: p.name, arguments: p.arguments || '' } };
                });
              if (newToolCalls.length) {
                msg.tool_calls = [...(msg.tool_calls || []), ...newToolCalls];
              }
              // Remove function_call parts from content — they're now in tool_calls
              msg.content = msg.content.filter(p => p.type !== 'function_call');
              if (!msg.content.length) msg.content = null;
            }
          }
          // role:"tool" messages (Chat-style) — only allow through if the call_id was emitted.
          // Orphan tool messages with no preceding assistant tool_calls cause upstream 400.
          if (msg.role === 'tool') {
            const toolCallId = msg.tool_call_id;
            if (!toolCallId || !emittedCallIds.has(toolCallId)) {
              process.stdout.write(`[proxy] tool message for unknown tool_call_id "${String(toolCallId ?? '').replace(/\n/g, '\\n')}" — skipped\n`);
              continue;
            }
          }
          chatMessages.push(msg);
          // After emitting an assistant message with tool_calls, flush any deferred outputs
          // that were buffered because their function_call came later in the array.
          if (msg.role === 'assistant' && msg.tool_calls?.length) {
            flushDeferred(msg.tool_calls.map(tc => tc.id));
          }
          continue;
        }
        // #11: log unsupported input item types so silent drops are visible in server output
        if (item.type) {
          process.stdout.write(`[proxy] unsupported input item type "${String(item.type).replace(/\n/g, '\\n')}" — skipped\n`);
        }
      }
    }
  }

  result.messages = reorderToolMessages(sanitizeMessages(chatMessages));

  // Force n=1 — the converter only reads choices[0]; n>1 would silently drop extra choices
  result.n = 1;

  if (max_output_tokens != null) result.max_tokens = max_output_tokens;

  if (text?.format) {
    const fmt = text.format;
    if (fmt.type === 'json_schema' && (fmt.name || fmt.schema || fmt.strict != null)) {
      const jsonSchema = {};
      if (fmt.name) jsonSchema.name = fmt.name;
      if (fmt.schema) jsonSchema.schema = fmt.schema;
      if (fmt.strict != null) jsonSchema.strict = fmt.strict;
      if (fmt.description) jsonSchema.description = fmt.description;
      result.response_format = { type: 'json_schema', json_schema: jsonSchema };
    } else {
      result.response_format = fmt;
    }
  }

  if (tools) {
    const mapped = [];
    for (const tool of tools) {
      if (tool.type !== 'function') {
        // Built-in Responses API tools (web_search_preview, file_search, etc.) have no
        // Chat Completions equivalent — log and skip so the caller is aware.
        process.stdout.write(`[proxy] tool type "${String(tool.type).replace(/\n/g, '\\n')}" is not supported by Chat Completions — skipped\n`);
        continue;
      }
      // Destructure `type` out of rest to prevent it leaking into the function object
      const { name, description, parameters, strict, type: _type, ...rest } = tool;
      if (!name) {
        process.stdout.write(`[proxy] function tool missing name — skipped\n`);
        continue;
      }
      const fn = { name, description, parameters, ...rest };
      if (strict != null) fn.strict = strict;
      mapped.push({ type: 'function', function: fn });
    }
    const hasTools = mapped.length > 0;
    if (hasTools) {
      result.tools = mapped;
      // parallel_tool_calls is only meaningful when tools are present
      if (parallel_tool_calls != null) result.parallel_tool_calls = parallel_tool_calls;
    }

    // #12: convert Responses tool_choice format → Chat Completions format
    // If all tools were skipped (e.g. only built-in types), drop tool_choice entirely —
    // sending tool_choice without tools causes an upstream 400.
    if (tool_choice != null && !hasTools) {
      process.stdout.write(`[proxy] tool_choice ignored — no tools remain after skipping unsupported types\n`);
    } else if (tool_choice != null) {
      const toolNames = hasTools ? new Set(mapped.map(t => t.function.name)) : null;
      if (tool_choice && typeof tool_choice === 'object' && tool_choice.type === 'function') {
        if (tool_choice.name) {
          if (toolNames && !toolNames.has(tool_choice.name)) {
            process.stdout.write(`[proxy] tool_choice function "${String(tool_choice.name).replace(/\n/g, '\\n')}" not in tools list — falling back to "auto"\n`);
            result.tool_choice = 'auto';
          } else {
            // Responses: { type: "function", name: "x" } → Chat: { type: "function", function: { name: "x" } }
            result.tool_choice = { type: 'function', function: { name: tool_choice.name } };
          }
        } else {
          // { type:"function" } without name is not valid Chat tool_choice — fall back to "auto"
          process.stdout.write(`[proxy] tool_choice { type:"function" } missing name — falling back to "auto"\n`);
          result.tool_choice = 'auto';
        }
      } else if (tool_choice && typeof tool_choice === 'object' && tool_choice.type && tool_choice.type !== 'function') {
        // #4: non-function object tool_choice (e.g. built-in tool choice) has no Chat equivalent — skip
        process.stdout.write(`[proxy] tool_choice type "${String(tool_choice.type).replace(/\n/g, '\\n')}" is not supported by Chat Completions — skipped\n`);
      } else if (typeof tool_choice === 'string') {
        // Only the three values Chat Completions defines are valid; anything else is rejected upstream
        if (tool_choice === 'auto' || tool_choice === 'none' || tool_choice === 'required') {
          result.tool_choice = tool_choice;
        } else {
          process.stdout.write(`[proxy] unknown string tool_choice "${String(tool_choice).replace(/\n/g, '\\n')}" — falling back to "auto"\n`);
          result.tool_choice = 'auto';
        }
      } else {
        result.tool_choice = tool_choice;
      }
    }
  } else if (tool_choice != null) {
    // No tools field at all — only "auto" and "none" are safe without tools; "required" would cause 400
    if (typeof tool_choice === 'string' && (tool_choice === 'auto' || tool_choice === 'none')) {
      result.tool_choice = tool_choice;
    } else {
      process.stdout.write(`[proxy] tool_choice ignored — no tools defined\n`);
    }
  }

  return result;
}

// Converts a non-streaming Chat Completions response to Responses API format
export function convertChatToResponsesOutput(chatResp) {
  const { id, model, choices, usage } = chatResp;
  const choice = choices?.[0];
  const msg = choice?.message;
  const finishReason = choice?.finish_reason;

  // #3: map finish_reason to Responses API status
  const status = (finishReason === 'length' || finishReason === 'content_filter') ? 'incomplete' : 'completed';
  // #2: include incomplete_details when status is incomplete
  const incompleteDetails = finishReason === 'length'
    ? { reason: 'max_output_tokens' }
    : finishReason === 'content_filter'
      ? { reason: 'content_filter' }
      : undefined;

  const output = [];

  // #10: handle refusal content
  if (msg?.refusal) {
    output.push({
      type: 'message',
      id: `msg_${id || Date.now()}_refusal`,
      status,
      role: msg.role || 'assistant',
      content: [{ type: 'refusal', refusal: msg.refusal }]
    });
  }

  // #5: if both content and tool_calls are present, include both
  if (msg?.content) {
    // #6: content may be an array of parts (some providers) — extract text and refusal parts
    let text;
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text).join('');
      // refusal parts in the content array (alternative to top-level msg.refusal)
      const refusalParts = msg.content.filter(p => p.type === 'refusal');
      for (const part of refusalParts) {
        if (!msg.refusal) {
          output.push({
            type: 'message',
            id: `msg_${id || Date.now()}_refusal`,
            status,
            role: msg.role || 'assistant',
            content: [{ type: 'refusal', refusal: part.refusal }]
          });
        }
        // if msg.refusal already handled above, skip duplicate
      }
      const nonTextNonRefusal = msg.content.filter(p => p.type !== 'text' && p.type !== 'refusal');
      if (nonTextNonRefusal.length) {
        process.stdout.write(`[proxy] non-text content parts dropped in Responses conversion: ${nonTextNonRefusal.map(p => String(p.type).replace(/\n/g, '\\n')).join(', ')}\n`);
      }
      text = textParts;
    } else {
      text = msg.content;
    }
    // skip if the array had no text parts (e.g. only refusal/image parts already handled above)
    if (text) {
      output.push({
        type: 'message',
        id: `msg_${id || Date.now()}_text`,
        status,
        role: msg.role || 'assistant',
        content: [{ type: 'output_text', text }]
      });
    }
  }

  if (msg?.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      if (!tc.function) continue;
      output.push({
        type: 'function_call',
        status,
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name ?? '',
        arguments: tc.function.arguments ?? ''
      });
    }
  }

  // Fallback: no content, no refusal, no tool_calls — emit empty message
  if (!output.length) {
    output.push({
      type: 'message',
      id: `msg_${id || Date.now()}_text`,
      status,
      role: msg?.role || 'assistant',
      content: [{ type: 'output_text', text: '' }]
    });
  }

  return {
    id: id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: model || '',
    status,
    ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
    output,
    usage: usage ? convertUsage(usage) : undefined
  };
}

export function convertUsage(usage) {
  const { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details, completion_tokens_details, ...rest } = usage;
  return {
    input_tokens: prompt_tokens,
    output_tokens: completion_tokens,
    total_tokens,
    ...(prompt_tokens_details !== undefined ? { input_tokens_details: prompt_tokens_details } : {}),
    ...(completion_tokens_details !== undefined ? { output_tokens_details: completion_tokens_details } : {}),
    ...rest
  };
}

export function parseChatSSELine(line, state) {
  // SSE spec allows both "data: {}" and "data:{}" — handle both
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return { done: true };

  let chunk;
  try { chunk = JSON.parse(data); } catch { return null; }

  const delta = chunk.choices?.[0]?.delta;
  const finishReason = chunk.choices?.[0]?.finish_reason;
  // Some providers (OpenAI with stream_options.include_usage=true) send a final chunk
  // with choices:[] and a top-level usage field. Capture it unconditionally so it is
  // available even if it arrives before the first content chunk (state.id not yet set).
  if (chunk.usage) state.pendingUsage = chunk.usage;

  if (!state.id) {
    state.id = chunk.id || `resp_${Date.now()}`;
    state.model = chunk.model || '';
    state.createdAt = Math.floor(Date.now() / 1000);
    state.outputItemCount = 0;
    const events = [
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: state.id, object: 'response', created_at: state.createdAt, model: state.model, status: 'in_progress' } }
      },
      {
        event: 'response.in_progress',
        data: { type: 'response.in_progress', response: { id: state.id, object: 'response', created_at: state.createdAt, model: state.model, status: 'in_progress' } }
      }
    ];
    if (delta?.content !== undefined && delta.content !== null) {
      _initTextItem(state, events);
      events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: state.itemId, output_index: state.outputIndex, content_index: 0, delta: delta.content } });
      state.textAccum = (state.textAccum || '') + delta.content;
    }
    if (delta?.tool_calls) {
      _captureToolCallMeta(delta.tool_calls, state, events);
      _processToolCallArgs(delta.tool_calls, state, events);
    }
    // #1: first chunk may also carry finish_reason. Record it but don't emit finish events yet —
    // a trailing usage-only chunk may still arrive before [DONE], so we defer to [DONE]/safety-net.
    if (finishReason) {
      state.finishReason = finishReason;
      if (chunk.usage) state.pendingUsage = chunk.usage;
    }
    return { multi: events };
  }

  // #1: a single chunk can carry content/tool_calls AND finish_reason simultaneously —
  // collect all events in one pass instead of returning early per branch
  const events = [];
  if (delta?.content !== undefined && delta.content !== null) {
    if (!state.textStarted) _initTextItem(state, events);
    events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: state.itemId, output_index: state.outputIndex, content_index: 0, delta: delta.content } });
    state.textAccum = (state.textAccum || '') + delta.content;
  }
  if (delta?.tool_calls) {
    _captureToolCallMeta(delta.tool_calls, state, events);
    _processToolCallArgs(delta.tool_calls, state, events);
  }
  if (finishReason) {
    state.finishReason = finishReason;
    if (chunk.usage) state.pendingUsage = chunk.usage;
  }
  return events.length ? { multi: events } : null;
}

// #7: also called when [DONE] arrives without a prior finish_reason chunk
// requireFinishReason=true: only emit if finishReason was received (used for no-[DONE] safety-net
// to avoid masking stream breaks as successes). Default false: [DONE] always implies completion.
export function buildFinishEventsIfNeeded(state, { requireFinishReason = false } = {}) {
  if (state.finishEmitted || !state.id) return null;
  // When called from the no-[DONE] safety-net, only emit finish events if a real finish signal
  // arrived — otherwise the stream broke mid-response and the caller should emit response.failed.
  if (requireFinishReason && !state.finishReason) return null;
  // prefer usage that arrived on the finish chunk; fall back to any usage-only chunk seen earlier
  return _buildFinishEvents(state, state.pendingUsage, state.finishReason);
}

function _buildFinishEvents(state, usage, finishReason) {
  state.finishEmitted = true;
  const usageConverted = usage ? convertUsage(usage) : undefined;
  // #3: map finish_reason to Responses API status
  const status = (finishReason === 'length' || finishReason === 'content_filter') ? 'incomplete' : 'completed';
  // #2: include incomplete_details when truncated or filtered
  const incompleteDetails = finishReason === 'length'
    ? { reason: 'max_output_tokens' }
    : finishReason === 'content_filter'
      ? { reason: 'content_filter' }
      : undefined;
  const events = [];
  const fullText = state.textAccum || '';
  // Text output item is incomplete when the response is cut short by length/content_filter
  const textItemStatus = status === 'incomplete' ? 'incomplete' : 'completed';
  if (state.textStarted) {
    events.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', item_id: state.itemId, output_index: state.outputIndex, content_index: 0, part: { type: 'output_text', text: fullText } } });
    events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: state.outputIndex, item: { id: state.itemId, type: 'message', status: textItemStatus, role: 'assistant', content: [{ type: 'output_text', text: fullText }] } } });
  }
  if (state.toolCallIds) {
    // #4: if the overall response is incomplete (e.g. length cutoff mid-arguments), mark the
    // tool call item as incomplete too — callers must not assume the arguments are valid JSON.
    const toolItemStatus = status === 'incomplete' ? 'incomplete' : 'completed';
    for (const [idxStr, callId] of Object.entries(state.toolCallIds)) {
      const toolIndex = Number(idxStr);
      const name = state.toolCallNames?.[toolIndex] || '';
      const args = state.toolCallArgs?.[toolIndex] || '';
      // use stored outputIndex (with text offset applied), not raw toolIndex
      const outputIndex = state.toolOutputIndex?.[toolIndex] ?? toolIndex;
      // If output_item.added was never sent (e.g. name and args both absent in all chunks),
      // emit it now before done so clients always see the added→done pair.
      if (!state.toolCallNameSent?.[toolIndex]) {
        events.push({
          event: 'response.output_item.added',
          data: { type: 'response.output_item.added', output_index: outputIndex, item: { id: callId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' } }
        });
      }
      events.push({
        event: 'response.function_call_arguments.done',
        data: { type: 'response.function_call_arguments.done', item_id: callId, output_index: outputIndex, name, arguments: args }
      });
      events.push({
        event: 'response.output_item.done',
        data: { type: 'response.output_item.done', output_index: outputIndex, item: { id: callId, type: 'function_call', status: toolItemStatus, name, call_id: callId, arguments: args } }
      });
    }
  }
  // Use response.incomplete event when the overall response status is incomplete
  const responseEventName = status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  events.push({
    event: responseEventName,
    data: { type: responseEventName, response: { id: state.id, object: 'response', created_at: state.createdAt, model: state.model, status, ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}), output: _buildOutput(state), ...(usageConverted ? { usage: usageConverted } : {}) } }
  });
  return events;
}

function _initTextItem(state, events) {
  // #3: use outputItemCount as the next outputIndex so text and tool indices never collide
  state.outputIndex = state.outputItemCount ?? 0;
  state.outputItemCount = (state.outputItemCount ?? 0) + 1;
  state.itemId = state.itemId || `msg_${state.id}`;
  state.textStarted = true;
  // #12: track insertion order for _buildOutput
  state.outputOrder = state.outputOrder || [];
  state.outputOrder.push({ kind: 'text', outputIndex: state.outputIndex });
  events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: state.outputIndex, item: { id: state.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } } });
  events.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: state.itemId, output_index: state.outputIndex, content_index: 0, part: { type: 'output_text', text: '' } } });
}

function _captureToolCallMeta(toolCalls, state, events) {
  state.toolCallIds = state.toolCallIds || {};
  state.toolCallNames = state.toolCallNames || {};
  state.toolCallNameSent = state.toolCallNameSent || {};
  for (const tc of toolCalls) {
    const toolIndex = tc.index ?? 0;
    // #4: once an id is assigned for this toolIndex, never overwrite it — keep first-seen id stable
    const callId = state.toolCallIds[toolIndex] || tc.id || `call_${toolIndex}`;
    const isNew = !state.toolCallIds[toolIndex];
    state.toolCallIds[toolIndex] = callId;
    if (tc.function?.name) state.toolCallNames[toolIndex] = (state.toolCallNames[toolIndex] || '') + tc.function.name;
    if (isNew) {
      // #3: outputIndex uses outputItemCount (which text also reads) so indices never collide
      const outputIndex = state.outputItemCount ?? 0;
      state.outputItemCount = (state.outputItemCount ?? 0) + 1;
      state.toolOutputIndex = state.toolOutputIndex || {};
      state.toolOutputIndex[toolIndex] = outputIndex;
      // #12: track insertion order for _buildOutput
      state.outputOrder = state.outputOrder || [];
      state.outputOrder.push({ kind: 'tool', toolIndex, outputIndex });
    }
    // Emit response.output_item.added as soon as we have a name. If name arrives on this same
    // chunk, send it now. This ensures added always precedes the first arguments.delta for this item.
    if (!state.toolCallNameSent[toolIndex] && state.toolCallNames[toolIndex]) {
      state.toolCallNameSent[toolIndex] = true;
      const name = state.toolCallNames[toolIndex];
      const outputIndex = state.toolOutputIndex[toolIndex];
      events.push({
        event: 'response.output_item.added',
        data: { type: 'response.output_item.added', output_index: outputIndex, item: { id: callId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' } }
      });
    }
  }
}

function _processToolCallArgs(toolCalls, state, events) {
  for (const tc of toolCalls) {
    if (!tc.function?.arguments) continue;
    const toolIndex = tc.index ?? 0;
    const callId = state.toolCallIds?.[toolIndex] || `call_${toolIndex}`;
    const outputIndex = state.toolOutputIndex?.[toolIndex] ?? toolIndex;
    // Guarantee output_item.added precedes the first arguments.delta. If the name hasn't arrived
    // yet (some providers stream name after arguments), emit added with empty name now so the
    // event order is always: added → delta(s) → done.
    if (!state.toolCallNameSent?.[toolIndex]) {
      state.toolCallNameSent = state.toolCallNameSent || {};
      state.toolCallNameSent[toolIndex] = true;
      const name = state.toolCallNames?.[toolIndex] || '';
      events.push({
        event: 'response.output_item.added',
        data: { type: 'response.output_item.added', output_index: outputIndex, item: { id: callId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' } }
      });
    }
    events.push({
      event: 'response.function_call_arguments.delta',
      data: { type: 'response.function_call_arguments.delta', item_id: callId, output_index: outputIndex, delta: tc.function.arguments }
    });
    state.toolCallArgs = state.toolCallArgs || {};
    state.toolCallArgs[toolIndex] = (state.toolCallArgs[toolIndex] || '') + tc.function.arguments;
  }
}

function _buildOutput(state) {
  const textItemStatus = (state.finishReason === 'length' || state.finishReason === 'content_filter') ? 'incomplete' : 'completed';
  // #4: tool call items also incomplete when the overall response was cut short
  const toolItemStatus = textItemStatus;
  // #12: preserve streaming insertion order rather than always text-first
  const order = state.outputOrder || [];
  const output = [];
  for (const item of order) {
    if (item.kind === 'text') {
      output.push({ id: state.itemId, type: 'message', status: textItemStatus, role: 'assistant', content: [{ type: 'output_text', text: state.textAccum || '' }] });
    } else if (item.kind === 'tool') {
      const { toolIndex } = item;
      const callId = state.toolCallIds?.[toolIndex];
      if (callId) {
        output.push({ id: callId, type: 'function_call', status: toolItemStatus, name: state.toolCallNames?.[toolIndex] || '', call_id: callId, arguments: state.toolCallArgs?.[toolIndex] || '' });
      }
    }
  }
  // fallback: if no order tracking (shouldn't happen), use old approach
  if (!output.length) {
    if (state.textStarted) {
      output.push({ id: state.itemId, type: 'message', status: textItemStatus, role: 'assistant', content: [{ type: 'output_text', text: state.textAccum || '' }] });
    }
    if (state.toolCallIds) {
      for (const [idxStr, callId] of Object.entries(state.toolCallIds)) {
        const toolIndex = Number(idxStr);
        output.push({ id: callId, type: 'function_call', status: toolItemStatus, name: state.toolCallNames?.[toolIndex] || '', call_id: callId, arguments: state.toolCallArgs?.[toolIndex] || '' });
      }
    }
  }
  // Always return an array — never undefined. Clients expect output:[] not output:undefined.
  // If there's truly nothing (e.g. finish-only chunk with no content), emit an empty message.
  if (!output.length) {
    const itemId = state.itemId || (state.id ? `msg_${state.id}_text` : `msg_${Date.now()}_text`);
    output.push({ id: itemId, type: 'message', status: textItemStatus, role: 'assistant', content: [{ type: 'output_text', text: '' }] });
  }
  return output;
}
