// Utility to fetch questions from Open Trivia DB (OpenTDB)
// API documentation: https://opentdb.com/api_config.php
import { questionSchema } from './schemas.js';

export const OPENTDB_CATEGORIES = {
  'General Knowledge': 9,
  'Entertainment: Books': 10,
  'Entertainment: Film': 11,
  'Entertainment: Music': 12,
  'Entertainment: Television': 14,
  'Entertainment: Video Games': 15,
  'Science & Nature': 17,
  'Science: Computers': 18,
  'Science: Mathematics': 19,
  'Mythology': 20,
  'Sports': 21,
  'Geography': 22,
  'History': 23,
  'Politics': 24,
  'Art': 25,
  'Celebrities': 26,
  'Animals': 27,
  'Vehicles': 28,
};

// Map OpenTDB categories into our streamlined app category names
export function mapToAppCategory(openTdbCatName) {
  if (!openTdbCatName) return 'General Knowledge';
  if (openTdbCatName.includes('Computers')) return 'Technology';
  if (openTdbCatName.includes('Science') || openTdbCatName.includes('Mathematics')) return 'Science';
  if (openTdbCatName.includes('Geography')) return 'World Geography';
  if (openTdbCatName.includes('History')) return 'History';
  if (openTdbCatName.includes('Sports')) return 'Sports';
  if (openTdbCatName.includes('Entertainment')) return 'Entertainment';
  return 'General Knowledge';
}

// Asked for RFC 3986 encoding (encode=url3986), so every field decodes exactly once with decodeURIComponent.
// (The default HTML-entity encoding needs a full entity table, and decoding &amp; first double-decodes "&amp;lt;".)
function decodeField(str) {
  if (typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str).trim();
  } catch {
    return '';
  }
}

/**
 * Fetches multiple choice trivia questions from OpenTDB.
 * @param {Object} options
 * @param {number} [options.amount=10] - Number of questions (1-50)
 * @param {number|string} [options.category] - OpenTDB category id
 * @param {string} [options.difficulty] - 'easy' | 'medium' | 'hard'
 * @returns {Promise<Array<{text: string, options: string[], correctIndex: number, category: string, timeLimit: number}>>}
 */
export async function fetchTriviaQuestions({ amount = 10, category = '', difficulty = '' } = {}) {
  const url = new URL('https://opentdb.com/api.php');
  url.searchParams.set('amount', Math.min(Math.max(Number(amount) || 10, 1), 50));
  url.searchParams.set('type', 'multiple');
  url.searchParams.set('encode', 'url3986');
  if (category) url.searchParams.set('category', category);
  if (difficulty) url.searchParams.set('difficulty', difficulty);

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'Quibble/1.0' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`OpenTDB responded with status ${res.status}`);
  const data = await res.json();

  if (data.response_code !== 0 || !Array.isArray(data.results)) {
    throw new Error(`OpenTDB returned code ${data.response_code}`);
  }

  // Imported questions go through the same rules as ones typed in the admin panel; anything that breaks them is skipped.
  return data.results.flatMap((item) => {
    const text = decodeField(item.question);
    const correct = decodeField(item.correct_answer);
    const incorrect = (Array.isArray(item.incorrect_answers) ? item.incorrect_answers : []).map(decodeField).slice(0, 3);

    // Shuffle options so the correct answer lands at a random index
    const allOptions = [...incorrect];
    const correctIndex = Math.floor(Math.random() * (incorrect.length + 1));
    allOptions.splice(correctIndex, 0, correct);

    const parsed = questionSchema.safeParse({
      text,
      options: allOptions,
      correctIndex,
      category: mapToAppCategory(decodeField(item.category)),
      timeLimit: 20,
    });
    return parsed.success ? [parsed.data] : [];
  });
}
