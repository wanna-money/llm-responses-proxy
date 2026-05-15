import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  convertResponsesToChatRequest,
  convertChatToResponsesOutput,
  convertUsage
} from '../src/proxy.js';

test('convertResponsesToChatRequest maps input to messages', () => {
  const req = { model: 'gpt-4o', input: [{ role: 'user', content: 'Hello' }] };
  const result = convertResponsesToChatRequest(req);
  assert.deepEqual(result.messages, [{ role: 'user', content: 'Hello' }]);
  assert.equal(result.model, 'gpt-4o');
  assert.equal(result.input, undefined);
});

test('convertResponsesToChatRequest converts developer role to system', () => {
  const req = {
    model: 'gpt-4o',
    input: [
      { role: 'developer', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' }
    ]
  };
  const result = convertResponsesToChatRequest(req);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].role, 'user');
});

test('convertResponsesToChatRequest converts function_call_output to tool message', () => {
  const req = {
    model: 'gpt-4o',
    input: [
      { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_123', output: '{"result":42}' }
    ]
  };
  const result = convertResponsesToChatRequest(req);
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'tool message should exist');
  assert.equal(toolMsg.tool_call_id, 'call_123');
  assert.equal(toolMsg.content, '{"result":42}');
});

test('convertResponsesToChatRequest maps max_output_tokens to max_tokens', () => {
  const req = { model: 'gpt-4o', input: [], max_output_tokens: 100 };
  const result = convertResponsesToChatRequest(req);
  assert.equal(result.max_tokens, 100);
  assert.equal(result.max_output_tokens, undefined);
});

test('convertResponsesToChatRequest converts input_image to image_url', () => {
  const req = {
    model: 'gpt-4o',
    input: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'input_image', image_url: 'https://example.com/img.png' }
      ]
    }]
  };
  const result = convertResponsesToChatRequest(req);
  const content = result.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'https://example.com/img.png');
});

test('convertResponsesToChatRequest nests tool fields under function', () => {
  const req = {
    model: 'gpt-4o',
    input: [],
    tools: [{ type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }]
  };
  const result = convertResponsesToChatRequest(req);
  assert.equal(result.tools[0].function.name, 'get_weather');
  assert.equal(result.tools[0].function.description, 'Get weather');
});

test('convertChatToResponsesOutput builds Responses output', () => {
  const chatResp = {
    id: 'chatcmpl-abc',
    model: 'gpt-4o',
    choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  const result = convertChatToResponsesOutput(chatResp);
  assert.equal(result.object, 'response');
  assert.equal(result.status, 'completed');
  assert.equal(result.output[0].type, 'message');
  assert.equal(result.output[0].content[0].type, 'output_text');
  assert.equal(result.output[0].content[0].text, 'Hello');
});

test('convertChatToResponsesOutput maps tool calls to function_call output items', () => {
  const chatResp = {
    id: 'chatcmpl-abc',
    model: 'gpt-4o',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  const result = convertChatToResponsesOutput(chatResp);
  assert.equal(result.output[0].type, 'function_call');
  assert.equal(result.output[0].name, 'get_weather');
  assert.equal(result.output[0].call_id, 'call_1');
});

test('convertUsage maps Chat usage to Responses usage', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  const result = convertUsage(usage);
  assert.equal(result.input_tokens, 10);
  assert.equal(result.output_tokens, 20);
  assert.equal(result.total_tokens, 30);
});

test('convertResponsesToChatRequest: function_call_output falls back to item.id when call_id is absent', () => {
  const req = {
    model: 'gpt-4o',
    input: [
      { type: 'function_call', id: 'id_only_456', name: 'do_thing', arguments: '{}' },
      { type: 'function_call_output', id: 'id_only_456', output: '{"ok":true}' }
    ]
  };
  const result = convertResponsesToChatRequest(req);
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'tool message should exist');
  assert.equal(toolMsg.tool_call_id, 'id_only_456');
});

test('convertChatToResponsesOutput: tool_calls status mirrors overall response status', () => {
  const chatResp = {
    id: 'chatcmpl-x',
    model: 'gpt-4o',
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_t', type: 'function', function: { name: 'fn', arguments: '{"x"' } }] },
      finish_reason: 'length'
    }]
  };
  const result = convertChatToResponsesOutput(chatResp);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.output[0].status, 'incomplete', 'tool call item must be incomplete when response is incomplete');
});

test('reorderToolMessages: system message between assistant tool_calls and tool reply is moved before', () => {
  const req = {
    model: 'gpt-4o',
    input: [
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'call_abc', name: 'run', arguments: '{}' },
      // system message interspersed between function_call and its output
      { type: 'message', role: 'system', content: 'Approved command saved' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
    ]
  };
  const { messages } = convertResponsesToChatRequest(req);
  // The system message must appear before the assistant(tool_calls) message
  const sysIdx = messages.findIndex(m => m.role === 'system' && m.content === 'Approved command saved');
  const assistIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'call_abc'));
  const toolIdx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_abc');
  assert.ok(sysIdx !== -1, 'system message must be present');
  assert.ok(assistIdx !== -1, 'assistant tool_calls message must be present');
  assert.ok(toolIdx !== -1, 'tool reply must be present');
  assert.ok(sysIdx < assistIdx, 'system message must come before assistant tool_calls');
  assert.ok(assistIdx < toolIdx, 'assistant tool_calls must come before tool reply');
});

test('convertResponsesToChatRequest: function_call_output before function_call in same array — correct ordering', () => {
  // Output appears before call: pre-pass should find the call_id, deferred output flushed after assistant msg
  const req = {
    model: 'gpt-4o',
    input: [
      { type: 'function_call_output', call_id: 'call_early', output: '{"result":1}' },
      { type: 'function_call', call_id: 'call_early', name: 'get_data', arguments: '{}' },
    ]
  };
  const { messages } = convertResponsesToChatRequest(req);
  const assistIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'call_early'));
  const toolIdx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_early');
  assert.ok(assistIdx !== -1, 'assistant tool_calls message must be present');
  assert.ok(toolIdx !== -1, 'tool message must be present');
  assert.ok(assistIdx < toolIdx, 'assistant tool_calls must come before tool reply even when output appears first');
});

test('convertResponsesToChatRequest: multi-turn function_call_output referencing prior-turn assistant tool_call', () => {
  // Second turn: prior-turn assistant message with tool_calls already in context as a message item
  const req = {
    model: 'gpt-4o',
    input: [
      { role: 'user', content: 'search for cats' },
      // Prior turn: assistant with tool_calls (Chat Completions format carried forward)
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_prior', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      // Current turn: the tool result
      { type: 'function_call_output', call_id: 'call_prior', output: '["cat1","cat2"]' },
    ]
  };
  const { messages } = convertResponsesToChatRequest(req);
  const assistIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === 'call_prior'));
  const toolIdx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_prior');
  assert.ok(assistIdx !== -1, 'prior-turn assistant tool_calls must be present');
  assert.ok(toolIdx !== -1, 'tool message for prior-turn call must be present');
  assert.ok(assistIdx < toolIdx, 'assistant tool_calls must come before tool reply');
});
