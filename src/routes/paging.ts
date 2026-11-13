import { z } from 'zod';

const schema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(50)
    .transform((n) => Math.min(n, 200)),
});

/** `?page=1&pageSize=50` → { page, pageSize, skip }. pageSize above 200 is capped at 200 (contract). */
export function paging(query: unknown) {
  const { page, pageSize } = schema.parse(query);
  return { page, pageSize, skip: (page - 1) * pageSize };
}
