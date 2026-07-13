// Fixes visual scrambling of mixed Arabic/Latin text in Discord's client.
//
// The scraped text itself is already in correct *logical* reading order
// (verified against X's own itemprop="text" source and other scrapers'
// plain-text extraction). But Discord's message renderer — like any
// Unicode-bidi-aware UI — reorders characters for *display* using the
// standard bidi algorithm. When an RTL (Arabic) paragraph contains inline
// LTR runs (English game/company names, acronyms, numbers) with only
// neutral characters (spaces, punctuation, emoji) around them, the
// algorithm can attach those neutrals to the wrong run and visually
// shuffle word order — exactly the "interleaved letters" users see,
// even though the underlying string is untouched.
//
// Fix: wrap every contiguous Latin/digit run in Unicode bidi isolate
// marks — U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE.
// This tells the renderer to treat each such run as an atomic LTR block
// that cannot be split or reordered relative to its neighbors, without
// altering the text content itself (isolates are zero-width control
// characters, invisible in the rendered message).
const LTR_RUN_RE = /[A-Za-z0-9][A-Za-z0-9 ,.:;'"!?()&%$#@_+=/*-]*/g;
const LRI = '\u2066';
const PDI = '\u2069';

function isolateLtrRuns(text) {
  if (!text) return text;
  return text.replace(LTR_RUN_RE, (run) => {
    const trimmed = run.replace(/\s+$/, '');
    if (!trimmed) return run;
    const trailingSpace = run.slice(trimmed.length);
    return `${LRI}${trimmed}${PDI}${trailingSpace}`;
  });
}

module.exports = { isolateLtrRuns };
