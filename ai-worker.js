/* Boxes — AI worker. Keeps the search off the UI thread.
 *
 * Receives {seq, state, level, budget}, replies {seq, ok, id}.
 */
'use strict';

importScripts('engine.js');
importScripts('ai.js');

self.onmessage = function (e) {
  const d = e.data || {};
  try {
    const state = Boxes.deserialize(d.state);
    const id = BoxesAI.choose(state, d.level, d.budget || {});
    self.postMessage({ seq: d.seq, ok: true, id: id === null ? null : id | 0 });
  } catch (err) {
    self.postMessage({ seq: d.seq, ok: false, error: String((err && err.message) || err) });
  }
};
