// Input validation for REST bodies AND WebSocket messages - sockets are an attack surface too.
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email('must be a valid email').max(120),
  username: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, 'must be 3-20 letters, numbers or underscores'),
  password: z.string().min(8, 'must be at least 8 characters').max(100),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(120),
  password: z.string().min(1).max(100),
});

export const questionSchema = z
  .object({
    text: z.string().trim().min(3).max(300),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(4),
    correctIndex: z.number().int().min(0),
    category: z.string().trim().min(1).max(40).default('General'),
    timeLimit: z.number().int().min(5).max(60).default(20),
  })
  .refine((q) => q.correctIndex < q.options.length, { path: ['correctIndex'], message: 'must point at one of the options' });

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

export const wsSchemas = {
  hello: z.object({}).optional(),
  ping: z.object({}).optional(),
  'game:create': z.object({
    category: z.string().trim().min(1).max(40).optional(), // single category (older clients)
    categories: z.array(z.string().trim().min(1).max(40)).max(50).optional(), // empty or missing = all
    count: z.number().int().min(1).max(30).default(10),
    hostPlays: z.boolean().default(false),
  }),
  'room:join': z.object({ code: z.string().trim().length(6) }),
  'game:start': z.object({}).optional(),
  'game:cancel': z.object({}).optional(),
  'room:leave': z.object({}).optional(),
  'answer:submit': z.object({ choice: z.number().int().min(0).max(3) }),
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
