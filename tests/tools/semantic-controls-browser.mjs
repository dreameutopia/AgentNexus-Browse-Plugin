// Run the real-browser semantic controls and existing DOM/AX input checks without
// the independent page-exec/dataRef suite. The normal probe still runs everything.
process.env.TEXT_SEMANTIC_ONLY = '1';
await import('./text-browser-probe.mjs');
