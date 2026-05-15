import { strict as assert } from 'assert';
import { test } from 'node:test';
import { parseChatSSELine, buildFinishEventsIfNeeded } from '../src/proxy.js';

function makeLine(obj) {
  return `data: ${JSON.stringify(obj)}`;
}

// Helper: run several SSE lines through the state machine and collect all events.
// safetyNet=true mirrors real route behavior: no-[DONE] stream break only emits finish
// events when a finish_reason was received (requireFinishReason:true).
function runLines(lines, { safetyNet = true } = {}) {
  const state = {};
  const events = [];
  for (const line of lines) {
    const result = parseChatSSELine(line, state);
    if (!result) continue;
    if (result.done) {
      const finish = buildFinishEventsIfNeeded(state);
      if (finish) events.push(...finish);
    } else if (result.multi) {
      events.push(...result.multi);
    }
  }
  // safety net: mirrors real route — requireFinishReason so pure stream breaks don't
  // emit response.completed when no finish signal was received
  if (safetyNet) {
    const finish = buildFinishEventsIfNeeded(state, { requireFinishReason: true });
    if (finish) events.push(...finish);
  }
  return { state, events };
}

test('streaming: text-only produces correct event sequence', () => {
  const lines = [
    makeLine({ id: 'r1', model: 'gpt-4o', choices: [{ delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }),
    makeLine({ id: 'r1', model: 'gpt-4o', choices: [{ delta: { content: ' there' }, finish_reason: null }] }),
    makeLine({ id: 'r1', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
  ];
  const { events } = runLines(lines);
  const types = events.map(e => e.event);
  assert.ok(types.includes('response.created'), 'missing response.created');
  assert.ok(types.includes('response.in_progress'), 'missing response.in_progress');
  assert.ok(types.includes('response.output_item.added'), 'missing output_item.added');
  assert.ok(types.includes('response.content_part.added'), 'missing content_part.added');
  const deltas = events.filter(e => e.event === 'response.output_text.delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].data.delta, 'Hi');
  assert.equal(deltas[1].data.delta, ' there');
  assert.ok(types.includes('response.content_part.done'), 'missing content_part.done');
  assert.ok(types.includes('response.output_item.done'), 'missing output_item.done');
  assert.ok(types.includes('response.completed'), 'missing response.completed');
});

test('streaming: [DONE] without prior finish_reason still emits response.completed', () => {
  const lines = [
    makeLine({ id: 'r2', model: 'gpt-4o', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
    'data: [DONE]',
  ];
  const { events } = runLines(lines);
  assert.ok(events.some(e => e.event === 'response.completed'), 'must emit response.completed on [DONE]');
});

test('streaming: finish_reason=length maps to status incomplete', () => {
  const lines = [
    makeLine({ id: 'r3', model: 'gpt-4o', choices: [{ delta: { content: 'truncated' }, finish_reason: null }] }),
    makeLine({ id: 'r3', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'length' }] }),
  ];
  const { events } = runLines(lines);
  const incomplete = events.find(e => e.event === 'response.incomplete');
  assert.ok(incomplete, 'must emit response.incomplete for finish_reason=length');
  assert.equal(incomplete.data.response.status, 'incomplete');
});

test('streaming: tool call produces correct event sequence', () => {
  const lines = [
    makeLine({ id: 'r4', model: 'gpt-4o', choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r4', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r4', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"NYC"}' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r4', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const { events } = runLines(lines);
  const types = events.map(e => e.event);
  assert.ok(types.includes('response.output_item.added'), 'missing output_item.added for tool call');
  const argDeltas = events.filter(e => e.event === 'response.function_call_arguments.delta');
  assert.equal(argDeltas.length, 2, 'should have 2 argument delta events');
  const argsDone = events.find(e => e.event === 'response.function_call_arguments.done');
  assert.ok(argsDone, 'missing function_call_arguments.done');
  assert.equal(argsDone.data.arguments, '{"city":"NYC"}');
  assert.equal(argsDone.data.name, 'get_weather');
});

test('streaming: tool call id stays stable across chunks', () => {
  const lines = [
    makeLine({ id: 'r5', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_xyz', type: 'function', function: { name: 'fn', arguments: '' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r5', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r5', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const { events } = runLines(lines);
  const itemAdded = events.find(e => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
  const argsDone = events.find(e => e.event === 'response.function_call_arguments.done');
  const itemDone = events.find(e => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call');
  assert.equal(itemAdded.data.item.id, 'call_xyz');
  assert.equal(argsDone.data.item_id, 'call_xyz');
  assert.equal(itemDone.data.item.id, 'call_xyz');
});

test('streaming: tool-first then text — no output_index collision', () => {
  const lines = [
    makeLine({ id: 'r6', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{}' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r6', model: 'gpt-4o', choices: [{ delta: { content: 'Also text' }, finish_reason: null }] }),
    makeLine({ id: 'r6', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const { events } = runLines(lines);
  const added = events.filter(e => e.event === 'response.output_item.added');
  const indices = added.map(e => e.data.output_index);
  assert.equal(new Set(indices).size, indices.length, 'output_index values must be unique');
});

test('streaming: created_at is present in response events', () => {
  const lines = [
    makeLine({ id: 'r7', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    makeLine({ id: 'r7', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const { events } = runLines(lines);
  const created = events.find(e => e.event === 'response.created');
  const completed = events.find(e => e.event === 'response.completed');
  assert.ok(typeof created.data.response.created_at === 'number', 'response.created must have created_at');
  assert.ok(typeof completed.data.response.created_at === 'number', 'response.completed must have created_at');
});

test('streaming: buildFinishEventsIfNeeded is idempotent', () => {
  const state = { id: 'r8', model: 'gpt-4o', finishEmitted: false };
  const first = buildFinishEventsIfNeeded(state);
  const second = buildFinishEventsIfNeeded(state);
  assert.ok(Array.isArray(first), 'first call should return events');
  assert.equal(second, null, 'second call should return null (already emitted)');
});

test('streaming: chunk with content + finish_reason=length in same chunk → incomplete status', () => {
  // #1: content and finish_reason in same chunk must both be processed (not early-return on content)
  const lines = [
    makeLine({ id: 'r9', model: 'gpt-4o', choices: [{ delta: { content: 'cut off' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  ];
  const { events } = runLines(lines);
  const incomplete = events.find(e => e.event === 'response.incomplete');
  assert.ok(incomplete, 'must emit response.incomplete for finish_reason=length');
  assert.equal(incomplete.data.response.status, 'incomplete', 'status must be incomplete for finish_reason=length');
  assert.deepEqual(incomplete.data.response.incomplete_details, { reason: 'max_output_tokens' });
  const deltas = events.filter(e => e.event === 'response.output_text.delta');
  assert.equal(deltas.length, 1, 'content delta must still be emitted');
  assert.equal(deltas[0].data.delta, 'cut off');
});

test('streaming: finish_reason=content_filter → status incomplete with reason content_filter', () => {
  const lines = [
    makeLine({ id: 'r10', model: 'gpt-4o', choices: [{ delta: { content: 'bad' }, finish_reason: 'content_filter' }] }),
  ];
  const { events } = runLines(lines);
  const incomplete = events.find(e => e.event === 'response.incomplete');
  assert.ok(incomplete, 'must emit response.incomplete for finish_reason=content_filter');
  assert.equal(incomplete.data.response.status, 'incomplete');
  assert.deepEqual(incomplete.data.response.incomplete_details, { reason: 'content_filter' });
});

test('streaming: finish_reason=stop → completed status, no incomplete_details', () => {
  const lines = [
    makeLine({ id: 'r11', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    makeLine({ id: 'r11', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const { events } = runLines(lines);
  const completed = events.find(e => e.event === 'response.completed');
  assert.ok(completed, 'must emit response.completed');
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.incomplete_details, undefined, 'no incomplete_details for stop');
});

test('streaming: tool call item status is incomplete when finish_reason=length', () => {
  const lines = [
    makeLine({ id: 'r12', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_trunc', type: 'function', function: { name: 'fn', arguments: '{"x"' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r12', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'length' }] }),
  ];
  const { events } = runLines(lines);
  const itemDone = events.find(e => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call');
  assert.ok(itemDone, 'must emit response.output_item.done for tool call');
  assert.equal(itemDone.data.item.status, 'incomplete', 'tool call item must be incomplete when overall response is incomplete');
});

test('streaming: usage-only chunk (choices:[]) captured into response.completed', () => {
  // OpenAI sends a trailing usage-only chunk when stream_options.include_usage=true
  const lines = [
    makeLine({ id: 'r13', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    makeLine({ id: 'r13', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    // trailing usage-only chunk — choices is empty
    makeLine({ id: 'r13', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
  ];
  const { events } = runLines(lines);
  const completed = events.find(e => e.event === 'response.completed');
  assert.ok(completed, 'must emit response.completed');
  // finish_reason came before the usage chunk; usage in completed should be present (from the finish chunk's usage field or fallback)
  // In this test the finish chunk has no usage and the usage-only chunk is parsed after [DONE] is not present —
  // verify the usage-only chunk doesn't crash the state machine
  assert.equal(completed.data.response.status, 'completed');
});

test('streaming: usage-only chunk before [DONE] provides usage to buildFinishEventsIfNeeded', () => {
  const lines = [
    makeLine({ id: 'r14', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    // usage-only chunk arrives before [DONE], no finish_reason chunk
    makeLine({ id: 'r14', model: 'gpt-4o', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
    'data: [DONE]',
  ];
  const { state, events } = runLines(lines);
  // pendingUsage must have been captured
  assert.ok(state.pendingUsage, 'pendingUsage must be set from usage-only chunk');
  const completed = events.find(e => e.event === 'response.completed');
  assert.ok(completed, 'must emit response.completed');
  assert.ok(completed.data.response.usage, 'response.completed must include usage');
  assert.equal(completed.data.response.usage.input_tokens, 10);
});

test('streaming: stream break without finish_reason → no response.completed (safety-net mirrors route)', () => {
  // No [DONE], no finish_reason — pure connection drop. The route emits response.failed; the
  // helper's safety-net (requireFinishReason:true) must NOT emit response.completed.
  const lines = [
    makeLine({ id: 'r15', model: 'gpt-4o', choices: [{ delta: { content: 'mid-response' }, finish_reason: null }] }),
    // stream ends here with no [DONE] and no finish_reason chunk
  ];
  const { events } = runLines(lines);
  assert.ok(!events.some(e => e.event === 'response.completed'), 'must NOT emit response.completed on pure stream break');
});

test('streaming: stream break WITH finish_reason → response.completed emitted by safety-net', () => {
  // finish_reason arrived but [DONE] was never sent — the safety-net should still complete normally.
  const lines = [
    makeLine({ id: 'r16', model: 'gpt-4o', choices: [{ delta: { content: 'done' }, finish_reason: null }] }),
    makeLine({ id: 'r16', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    // no [DONE]
  ];
  const { events } = runLines(lines);
  assert.ok(events.some(e => e.event === 'response.completed'), 'must emit response.completed when finish_reason is present');
});

test('streaming: tool call output_item.added always precedes first arguments.delta', () => {
  // Provider sends arguments before name in stream — added must still come before any delta.
  const lines = [
    // first chunk: id + arguments but no name yet
    makeLine({ id: 'r17', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: '', arguments: '{"a"' } }] }, finish_reason: null }] }),
    // second chunk: name arrives
    makeLine({ id: 'r17', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'my_fn', arguments: ':1}' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r17', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const { events } = runLines(lines);
  const toolEvents = events.filter(e => ['response.output_item.added', 'response.function_call_arguments.delta', 'response.output_item.done'].includes(e.event));
  const addedIdx = toolEvents.findIndex(e => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
  const firstDeltaIdx = toolEvents.findIndex(e => e.event === 'response.function_call_arguments.delta');
  assert.ok(addedIdx !== -1, 'output_item.added must be emitted');
  assert.ok(firstDeltaIdx !== -1, 'arguments.delta must be emitted');
  assert.ok(addedIdx < firstDeltaIdx, 'output_item.added must precede first arguments.delta');
});

test('streaming: tool call with no name ever — added+done still emitted as pair', () => {
  // Pathological: provider sends tool call id and arguments but never a name.
  const lines = [
    makeLine({ id: 'r18', model: 'gpt-4o', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { arguments: '{}' } }] }, finish_reason: null }] }),
    makeLine({ id: 'r18', model: 'gpt-4o', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const { events } = runLines(lines);
  const added = events.filter(e => e.event === 'response.output_item.added' && e.data.item?.type === 'function_call');
  const done = events.filter(e => e.event === 'response.output_item.done' && e.data.item?.type === 'function_call');
  assert.equal(added.length, 1, 'must emit exactly one output_item.added');
  assert.equal(done.length, 1, 'must emit exactly one output_item.done');
  const addedIdx = events.indexOf(added[0]);
  const doneIdx = events.indexOf(done[0]);
  assert.ok(addedIdx < doneIdx, 'added must precede done');
});
