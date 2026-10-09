// Is this message small talk — a greeting, thanks, "who are you"?
//
// Deliberately strict: EVERY word must come from the casual vocabulary, so a
// single domain word ("hi, how many cases today") makes it a real question.
// A miss here only costs a model call to route it; a false hit would answer a
// real question with chit-chat, so the asymmetry favours missing.
//
// Two uses: route straight to the casual lane (no knowledge-base or tool call
// for "hello"), and never show a source chip under a casual reply — nothing
// was looked up, so nothing can be cited.

const WORDS = new Set([
  // greetings / farewells
  'hi', 'hello', 'hey', 'hiya', 'yo', 'hola', 'namaste', 'namaskar', 'namaskara', 'greetings',
  'good', 'morning', 'afternoon', 'evening', 'night', 'day',
  'bye', 'goodbye', 'cya', 'see', 'later', 'take', 'care',
  // thanks / acknowledgements
  'thanks', 'thank', 'thx', 'ty', 'cheers', 'appreciate', 'it', 'much', 'so', 'very', 'a', 'lot',
  'ok', 'okay', 'k', 'cool', 'great', 'nice', 'awesome', 'perfect', 'got', 'sure', 'alright', 'fine',
  // "how are you" / "who are you"
  'how', 'are', 'you', 'u', 'doing', 'is', 'going', 'whats', 'what', 'up', 'sup', 'who', 'your', 'name',
  // address terms
  'there', 'sentinel', 'assistant', 'bot', 'all', 'team', 'sir', 'madam', 'buddy', 'again', 'and', 'too',
  // Hindi / Kannada greetings in their own scripts
  'नमस्ते', 'नमस्कार', 'धन्यवाद', 'शुक्रिया', 'ನಮಸ್ಕಾರ', 'ಧನ್ಯವಾದ', 'ಧನ್ಯವಾದಗಳು',
]);

// Words that can appear in the vocabulary above but never alone make a message
// casual ("what", "is", "it" are everywhere in real questions).
const NEEDS_ANCHOR = new Set(['what', 'is', 'it', 'how', 'who', 'are', 'you', 'u', 'your', 'a', 'and', 'so', 'very', 'much', 'all', 'there', 'day', 'see', 'take', 'got', 'sure', 'fine', 'up', 'name', 'doing', 'going', 'again', 'too', 'k']);
const ANCHOR_PHRASES = [/\bhow (are|r) (you|u)\b/, /\bwho are (you|u)\b/, /\bwhat'?s up\b/, /\bwhat is your name\b/, /\bhow is it going\b/];

function isSmallTalk(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s || s.length > 80) return false;
  const words = s.replace(/[’']/g, '').split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  if (!words.every((w) => WORDS.has(w))) return false;
  // At least one word that is casual on its own, or a recognised casual phrase.
  return words.some((w) => !NEEDS_ANCHOR.has(w)) || ANCHOR_PHRASES.some((re) => re.test(s.replace(/[’]/g, "'")));
}

module.exports = { isSmallTalk };
