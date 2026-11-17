/**
 * Complete OpenAPI 3.0.3 specification for all ABM-AIPEC Backend endpoints.
 * Served interactively at `/docs` (Swagger UI) and raw JSON at `/docs/openapi.json`.
 */

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'MongoDB ObjectId of the resource',
};

const editionQuery = {
  name: 'edition',
  in: 'query',
  required: false,
  schema: { type: 'integer', example: 2026 },
  description: 'Event edition year (defaults to newest edition when omitted)',
};

const pageQuery = {
  name: 'page',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, default: 1 },
};

const pageSizeQuery = {
  name: 'pageSize',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
};

const errResp = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

const authSecurity = [{ cookieAuth: [] }];

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ABM-AIPEC Research & Outreach API',
    version: '0.1.0',
    description:
      'REST API for ADIPEC exhibitor discovery, official website scraping & backtracking, contact management, free DNS MX verification, and OpenRouter AI outreach drafting.',
  },
  servers: [{ url: '/', description: 'Current server' }],
  tags: [
    { name: 'System', description: 'Health check and scheduled cron triggers' },
    { name: 'Auth', description: 'Cookie-based JWT authentication' },
    { name: 'Users', description: 'Admin user management' },
    { name: 'Events', description: 'ADIPEC editions and directory metadata' },
    { name: 'Runs', description: 'Pipeline batch runs (start, inspect, pause, resume)' },
    { name: 'Companies', description: 'Exhibitor companies, edits, step overrides, merges, and history' },
    { name: 'Contacts', description: 'Company contacts and CSV import' },
    { name: 'AI', description: 'AI research notes and outreach draft regeneration & approval' },
    { name: 'Review', description: 'Human-in-the-loop review queues' },
    { name: 'Exports', description: 'CSV/JSON exports and export audit log' },
    { name: 'Verification', description: 'Batch email verification triggers' },
    { name: 'Settings', description: 'Provider status and suppression (opt-out) list' },
    { name: 'Stats & Reports', description: 'Overview metrics and gap reports' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'token',
        description: 'HTTP-only JWT cookie set by POST /auth/login',
      },
      cronSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'x-cron-secret',
        description: 'Shared CRON_SECRET for scheduled worker triggers',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'bad_request' },
              message: { type: 'string' },
              details: { type: 'object', nullable: true },
            },
            required: ['code', 'message'],
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'reviewer'] },
        },
        required: ['id', 'email', 'role'],
      },
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          edition: { type: 'integer', example: 2026 },
          name: { type: 'string', example: 'ADIPEC 2026' },
          directoryUrl: { type: 'string', format: 'uri' },
          advertisedCount: { type: 'integer', nullable: true },
        },
      },
      StepState: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['not_started', 'in_progress', 'completed', 'partial', 'needs_review', 'restricted', 'pending_access', 'failed'],
          },
          reason: { type: 'string', nullable: true },
          updatedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      RunSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          edition: { type: 'integer' },
          status: { type: 'string', enum: ['running', 'paused', 'completed', 'failed'] },
          steps: { type: 'array', items: { type: 'string' } },
          startedBy: { type: 'string' },
          startedAt: { type: 'string', format: 'date-time' },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
          discovered: { type: 'integer' },
          duplicates: { type: 'integer' },
        },
      },
      Suppression: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          value: { type: 'string', example: 'optout.example' },
          reason: { type: 'string', nullable: true },
          at: { type: 'string', format: 'date-time' },
        },
      },
      Providers: {
        type: 'object',
        properties: {
          contactout: { type: 'boolean' },
          millionverifier: { type: 'boolean' },
          llm: { type: 'boolean' },
          llmModel: { type: 'string', nullable: true },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Service health check',
        responses: {
          200: {
            description: 'Health status for API, MongoDB, Redis, and worker count',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    mongo: { type: 'boolean' },
                    redis: { type: 'boolean' },
                    workers: { type: 'integer' },
                  },
                },
              },
            },
          },
          503: errResp('Database or Redis unavailable'),
        },
      },
    },
    '/cron/{task}': {
      post: {
        tags: ['System'],
        summary: 'Trigger a scheduled maintenance task',
        security: [{ cronSecret: [] }],
        parameters: [
          {
            name: 'task',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['verification', 'directory'] },
          },
        ],
        responses: {
          200: { description: 'Cron task accepted' },
          401: errResp('Invalid x-cron-secret'),
          404: errResp('Unknown cron task'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with email and password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'admin@example.com' },
                  password: { type: 'string', format: 'password', example: 'AdminPass123!' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Authenticated user (sets HTTP-only cookie)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          401: errResp('Wrong email or password'),
          429: errResp('Too many login attempts'),
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Clear session cookie',
        responses: { 204: { description: 'Logged out' } },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get currently signed-in user',
        security: authSecurity,
        responses: {
          200: { description: 'Current user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          401: errResp('Not authenticated'),
        },
      },
    },
    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List all users (admin only)',
        security: authSecurity,
        responses: {
          200: {
            description: 'Array of users',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
          },
          403: errResp('Admin role required'),
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Create a user (admin only)',
        security: authSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                  password: { type: 'string', minLength: 8 },
                  role: { type: 'string', enum: ['admin', 'reviewer'], default: 'reviewer' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          409: errResp('Email already registered'),
        },
      },
    },
    '/users/{id}': {
      patch: {
        tags: ['Users'],
        summary: 'Update user role or name (admin only)',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  role: { type: 'string', enum: ['admin', 'reviewer'] },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated user' }, 404: errResp('User not found') },
      },
      delete: {
        tags: ['Users'],
        summary: 'Delete a user (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 204: { description: 'Deleted' }, 404: errResp('User not found') },
      },
    },
    '/events': {
      get: {
        tags: ['Events'],
        summary: 'List all exhibition editions',
        security: authSecurity,
        responses: {
          200: {
            description: 'List of events',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Event' } } } },
          },
        },
      },
      post: {
        tags: ['Events'],
        summary: 'Create or upsert an exhibition edition (admin only)',
        security: authSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['edition', 'name', 'directoryUrl'],
                properties: {
                  edition: { type: 'integer', example: 2026 },
                  name: { type: 'string', example: 'ADIPEC 2026' },
                  directoryUrl: { type: 'string', format: 'uri' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created event' } },
      },
    },
    '/runs': {
      get: {
        tags: ['Runs'],
        summary: 'List pipeline runs',
        security: authSecurity,
        parameters: [editionQuery, pageQuery, pageSizeQuery],
        responses: { 200: { description: 'Paged runs' } },
      },
      post: {
        tags: ['Runs'],
        summary: 'Start a new live pipeline run (admin only)',
        security: authSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['edition'],
                properties: {
                  edition: { type: 'integer', example: 2026 },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['directory', 'profile', 'website', 'social', 'account', 'people', 'emails', 'verification', 'personalization'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Run started' }, 409: errResp('Another run is already active') },
      },
    },
    '/runs/{id}': {
      get: {
        tags: ['Runs'],
        summary: 'Get run progress and error log',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Run details' }, 404: errResp('Run not found') },
      },
    },
    '/runs/{id}/pause': {
      post: {
        tags: ['Runs'],
        summary: 'Pause a running pipeline run (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Paused run' }, 409: errResp('Run is not running') },
      },
    },
    '/runs/{id}/resume': {
      post: {
        tags: ['Runs'],
        summary: 'Resume a paused pipeline run (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Resumed run' }, 409: errResp('Run is not paused') },
      },
    },
    '/companies': {
      get: {
        tags: ['Companies'],
        summary: 'Search, filter, sort, and paginate companies',
        security: authSecurity,
        parameters: [
          editionQuery,
          pageQuery,
          pageSizeQuery,
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search by name, stand, domain, or country' },
          { name: 'country', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'step', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'aiStatus', in: 'query', schema: { type: 'string', enum: ['pending', 'draft', 'approved', 'insufficient_evidence'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'completeness', 'contacts', 'updated'] } },
          { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
        ],
        responses: { 200: { description: 'Paged company list' } },
      },
    },
    '/companies/{id}': {
      get: {
        tags: ['Companies'],
        summary: 'Get full company profile, scraped facts, contacts, and AI drafts',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Company detail' }, 404: errResp('Company not found') },
      },
      patch: {
        tags: ['Companies'],
        summary: 'Edit company fields (locks edited fields and records history)',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  website: {
                    type: 'object',
                    properties: {
                      url: { type: 'string', nullable: true },
                      summary: { type: 'string', nullable: true },
                      services: { type: 'array', items: { type: 'string' } },
                      markets: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  socials: {
                    type: 'object',
                    properties: {
                      linkedin: { type: 'string', nullable: true },
                      facebook: { type: 'string', nullable: true },
                      instagram: { type: 'string', nullable: true },
                      x: { type: 'string', nullable: true },
                      youtube: { type: 'string', nullable: true },
                    },
                  },
                  leadershipCoverage: { type: 'string', enum: ['unknown', 'none_found', 'partial', 'covered'] },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated company' }, 409: errResp('Domain conflict with another company') },
      },
      delete: {
        tags: ['Companies'],
        summary: 'Delete a company and its contacts (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 204: { description: 'Deleted' }, 404: errResp('Company not found') },
      },
    },
    '/companies/{id}/steps/{step}': {
      post: {
        tags: ['Companies'],
        summary: 'Manually override or retry a pipeline step for a company',
        security: authSecurity,
        parameters: [
          idParam,
          {
            name: 'step',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['profile', 'website', 'social', 'account', 'people', 'emails', 'verification', 'personalization'],
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: {
                    type: 'string',
                    enum: ['completed', 'partial', 'needs_review', 'restricted', 'pending_access', 'failed', 'not_started'],
                  },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated company' } },
      },
    },
    '/companies/{id}/merge': {
      post: {
        tags: ['Companies'],
        summary: 'Merge duplicate company into target company',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['intoId'], properties: { intoId: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Merged target company' } },
      },
    },
    '/companies/{id}/not-duplicate': {
      post: {
        tags: ['Companies'],
        summary: 'Dismiss duplicate flag between two companies',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Updated company' } },
      },
    },
    '/companies/{id}/history': {
      get: {
        tags: ['Companies'],
        summary: 'Get audit history of edits for a company',
        security: authSecurity,
        parameters: [idParam],
        responses: { 200: { description: 'Array of history entries' } },
      },
    },
    '/companies/{id}/contacts': {
      post: {
        tags: ['Companies'],
        summary: 'Add a contact to a company',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['firstName', 'lastName'],
                properties: {
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  title: { type: 'string' },
                  profileUrl: { type: 'string' },
                  emails: {
                    type: 'array',
                    items: { type: 'object', properties: { address: { type: 'string' }, type: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created contact' } },
      },
    },
    '/companies/{id}/contacts/import': {
      post: {
        tags: ['Companies'],
        summary: 'Bulk import contacts from CSV rows for a company',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['csv'], properties: { csv: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Import summary (created, skipped, errors)' } },
      },
    },
    '/contacts/{id}': {
      patch: {
        tags: ['Contacts'],
        summary: 'Update a contact',
        security: authSecurity,
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated contact' } },
      },
      delete: {
        tags: ['Contacts'],
        summary: 'Delete a contact (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 204: { description: 'Deleted' } },
      },
    },
    '/companies/{id}/ai/regenerate': {
      post: {
        tags: ['AI'],
        summary: 'Queue AI regeneration for a company research note & pitch',
        security: authSecurity,
        parameters: [idParam],
        responses: { 202: { description: 'Queued for generation' } },
      },
    },
    '/companies/{id}/ai': {
      patch: {
        tags: ['AI'],
        summary: 'Save edits or approve company AI research note',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['save', 'approve'] },
                  fields: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated company AI payload' }, 409: errResp('No draft available to approve') },
      },
    },
    '/contacts/{id}/ai/regenerate': {
      post: {
        tags: ['AI'],
        summary: 'Queue AI outreach draft regeneration for a contact',
        security: authSecurity,
        parameters: [idParam],
        responses: { 202: { description: 'Queued for generation' } },
      },
    },
    '/contacts/{id}/ai': {
      patch: {
        tags: ['AI'],
        summary: 'Save edits or approve contact AI outreach drafts',
        security: authSecurity,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['save', 'approve'] },
                  fields: { type: 'object' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Updated contact AI payload' } },
      },
    },
    '/review/counts': {
      get: {
        tags: ['Review'],
        summary: 'Get pending item counts across all 6 review queues',
        security: authSecurity,
        parameters: [editionQuery],
        responses: { 200: { description: 'Counts map by review queue type' } },
      },
    },
    '/review': {
      get: {
        tags: ['Review'],
        summary: 'Fetch items in a specific review queue',
        security: authSecurity,
        parameters: [
          {
            name: 'type',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['website', 'duplicate', 'salesnav', 'contacts', 'emails', 'ai'] },
          },
          editionQuery,
          pageQuery,
          pageSizeQuery,
        ],
        responses: { 200: { description: 'Paged review queue items' } },
      },
    },
    '/exports/log': {
      get: {
        tags: ['Exports'],
        summary: 'List historical export audit entries',
        security: authSecurity,
        responses: { 200: { description: 'Array of export log items' } },
      },
    },
    '/exports/{kind}/count': {
      get: {
        tags: ['Exports'],
        summary: 'Preview how many rows an export will include',
        security: authSecurity,
        parameters: [
          { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['companies', 'contacts', 'outreach'] } },
          editionQuery,
        ],
        responses: { 200: { description: 'Export row count' } },
      },
    },
    '/exports/{file}': {
      get: {
        tags: ['Exports'],
        summary: 'Download CSV or JSON export (companies.csv, contacts.csv, outreach.csv, etc.)',
        security: authSecurity,
        parameters: [{ name: 'file', in: 'path', required: true, schema: { type: 'string', example: 'companies.csv' } }, editionQuery],
        responses: {
          200: { description: 'File download stream (text/csv or application/json)' },
          404: errResp('Unknown export file'),
        },
      },
    },
    '/verification/run': {
      post: {
        tags: ['Verification'],
        summary: 'Queue batch DNS MX / email verification for an edition (admin only)',
        security: authSecurity,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { edition: { type: 'integer', example: 2026 } } } } },
        },
        responses: { 202: { description: 'Verification jobs queued' } },
      },
    },
    '/settings/providers': {
      get: {
        tags: ['Settings'],
        summary: 'Check which optional providers and LLM model are enabled',
        security: authSecurity,
        responses: {
          200: {
            description: 'Provider status flags',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Providers' } } },
          },
        },
      },
    },
    '/suppressions': {
      get: {
        tags: ['Settings'],
        summary: 'List opt-out emails and domains (admin only)',
        security: authSecurity,
        responses: {
          200: {
            description: 'Suppression entries',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Suppression' } } } },
          },
        },
      },
      post: {
        tags: ['Settings'],
        summary: 'Add an email or domain to the suppression list (admin only)',
        security: authSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['value'],
                properties: {
                  value: { type: 'string', example: 'optout.example' },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created suppression rule' } },
      },
    },
    '/suppressions/{id}': {
      delete: {
        tags: ['Settings'],
        summary: 'Remove a suppression rule (admin only)',
        security: authSecurity,
        parameters: [idParam],
        responses: { 204: { description: 'Deleted' }, 404: errResp('Suppression not found') },
      },
    },
    '/stats/overview': {
      get: {
        tags: ['Stats & Reports'],
        summary: 'Dashboard overview metrics for an edition',
        security: authSecurity,
        parameters: [editionQuery],
        responses: { 200: { description: 'Overview statistics' } },
      },
    },
    '/reports/gap': {
      get: {
        tags: ['Stats & Reports'],
        summary: 'Gap report (JSON) of incomplete/blocked companies',
        security: authSecurity,
        parameters: [editionQuery],
        responses: { 200: { description: 'Gap report JSON' } },
      },
    },
    '/reports/gap.csv': {
      get: {
        tags: ['Stats & Reports'],
        summary: 'Gap report download (CSV)',
        security: authSecurity,
        parameters: [editionQuery],
        responses: { 200: { description: 'CSV download' } },
      },
    },
  },
} as const;
