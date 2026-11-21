// Input validation for REST bodies AND WebSocket messages - sockets are an attack surface too.
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email('must be a valid email').max(120),
  username: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, 'must be 3-20 letters, numbers or underscores'),
  // bcrypt only uses the first 72 BYTES: longer passwords would silently match anything sharing that prefix.
  password: z
    .string()
    .min(8, 'must be at least 8 characters')
    .max(72, 'must be at most 72 characters')
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'is too long (use fewer special characters)'),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(1).max(100),
});

const shortText = z.string().trim().min(1).max(100);
const QUESTION_TYPES = ['choice', 'truefalse', 'type', 'order', 'number'];

/**
 * One question of any type (see lib/qtypes.js). Fields that don't belong to the type are dropped, so what is stored
 * is always exactly cleanQuestion(q).
 */
export const questionSchema = z
  .object({
    type: z.enum(QUESTION_TYPES).default('choice'),
    text: z.string().trim().min(3).max(300),
    category: z.string().trim().min(1).max(40).default('General'),
    timeLimit: z.number().int().min(5).max(60).default(20),
    options: z.array(shortText).max(4).optional(),
    correctIndex: z.number().int().min(0).optional(),
    answers: z.array(z.string().trim().min(1).max(60)).min(1).max(5).optional(),
    items: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
    answer: z.number().gte(-1e12).lte(1e12).optional(),
    tolerance: z.number().min(0).lte(1e12).optional(),
    unit: z.string().trim().max(20).optional(),
  })
  .superRefine((q, ctx) => {
    const need = (ok, path, message) => { if (!ok) ctx.addIssue({ code: 'custom', path: [path], message }); };
    if (q.type === 'choice') {
      need(q.options && q.options.length >= 2, 'options', 'needs 2 to 4 options');
      need(q.correctIndex !== undefined && q.options && q.correctIndex < q.options.length, 'correctIndex', 'must point at one of the options');
    } else if (q.type === 'truefalse') {
      need(q.correctIndex === 0 || q.correctIndex === 1, 'correctIndex', 'must be 0 (true) or 1 (false)');
    } else if (q.type === 'type') {
      need(q.answers?.length, 'answers', 'needs at least one accepted answer');
    } else if (q.type === 'order') {
      need(q.items && q.items.length >= 3, 'items', 'needs 3 to 5 items');
      need(q.items && new Set(q.items.map((s) => s.toLowerCase())).size === q.items.length, 'items', 'must all be different');
    } else if (q.type === 'number') {
      need(q.answer !== undefined, 'answer', 'needs the right number');
    }
  })
  .transform((q) => {
    const base = { type: q.type, text: q.text, category: q.category, timeLimit: q.timeLimit };
    if (q.type === 'choice') return { ...base, options: q.options, correctIndex: q.correctIndex };
    if (q.type === 'truefalse') return { ...base, options: ['True', 'False'], correctIndex: q.correctIndex };
    if (q.type === 'type') return { ...base, answers: q.answers };
    if (q.type === 'order') return { ...base, items: q.items };
    return { ...base, answer: q.answer, tolerance: q.tolerance ?? 0, ...(q.unit ? { unit: q.unit } : {}) };
  });

/** A quiz someone made (My quizzes). Up to 30 questions: a game never has more. */
export const quizSchema = z.object({
  title: z.string().trim().min(3).max(60),
  description: z.string().trim().max(200).optional().default(''),
  shared: z.boolean().optional().default(false),
  questions: z.array(questionSchema).min(1).max(30),
});

export const userPatchSchema = z
  .object({
    role: z.enum(['player', 'admin']).optional(),
    banned: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.banned !== undefined, { message: 'nothing to update' });

export const triviaImportSchema = z.object({
  amount: z.coerce.number().int().min(1).max(50).default(10),
  category: z.union([z.string(), z.number()]).optional().default(''),
  difficulty: z.enum(['', 'easy', 'medium', 'hard']).optional().default(''),
});

const gameCode = z.string().trim().length(6).transform((c) => c.toUpperCase());
const hello = z.object({ protocol: z.number().int().optional() });

export const wsSchemas = {
  hello,
  sync: hello, // the client's watchdog: same as hello, sent when a phase change seems to have been missed
  ping: z.object({}).optional(),
  'game:create': z.object({
    category: z.string().trim().min(1).max(40).optional(), // single category (older clients)
    categories: z.array(z.string().trim().min(1).max(40)).max(50).optional(), // empty or missing = all
    count: z.number().int().min(1).max(30).default(10),
    hostPlays: z.boolean().default(false),
    types: z.array(z.enum(QUESTION_TYPES)).max(5).optional(), // empty or missing = every type
    quizId: z.string().uuid().optional(), // host one of "My quizzes" (or a shared one) instead of the question bank
    shuffle: z.boolean().default(false), // a quiz's questions in random order
    bigScreen: z.boolean().default(false), // the host's screen is a projector; phones only answer
    doublePoints: z.boolean().default(false), // the last question and ~1 in 5 others are worth double
    // One id per "Create game" click, reused for its resends, so a resend can never create a second game.
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  }),
  'room:join': z.object({ code: gameCode }),
  'game:start': z.object({}).optional(),
  'game:cancel': z.object({}).optional(),
  'room:leave': z.object({}).optional(),
  'answer:submit': z
    .object({
      choice: z.number().int().min(0).max(3).optional(), // choice / truefalse: the option tapped
      text: z.string().max(60).optional(), // type: what was typed
      order: z.array(z.number().int().min(0).max(4)).min(2).max(5).optional(), // order: option indexes, first to last
      value: z.number().gte(-1e12).lte(1e12).optional(), // number: the guess
      index: z.number().int().min(0).max(29).optional(), // which question this answers
      code: gameCode.optional(),
    })
    .refine((a) => [a.choice, a.text, a.order, a.value].some((x) => x !== undefined), { message: 'no answer given' }),
  react: z.object({ emoji: z.number().int().min(0).max(7) }),
};

/** Parse or throw a readable "field: message" error. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.join('.') || 'body';
  const err = new Error(`${field}: ${issue.message}`);
  err.validation = true;
  throw err;
}
