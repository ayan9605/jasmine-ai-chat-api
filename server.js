import express from 'express';
import { request } from 'undici';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import helmet from 'helmet';
import { apiReference } from '@scalar/express-api-reference';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

// Cache with 5 minute TTL and 10 minute check period
const cache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

// Security middleware - Configure Helmet to allow Scalar docs
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression()); // Gzip compression
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// Default system prompt
const DEFAULT_SYSTEM = "I want you to act as a college student who is a girl in 18 years old and your name is Jasmine...";

// Fetch nonce with caching
async function fetchNonce() {
  const cachedNonce = cache.get('nonce');
  if (cachedNonce) return cachedNonce;

  try {
    const { statusCode, body } = await request('https://mistral-ai.chat/', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxRedirections: 3,
      bodyTimeout: 10000,
      headersTimeout: 10000
    });

    if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

    const html = await body.text();
    const nonceMatch = html.match(/nonce":"(.*?)"/);
    
    if (!nonceMatch) throw new Error('Nonce not found in HTML');

    const nonce = nonceMatch[1];
    cache.set('nonce', nonce, 3600); // Cache for 1 hour
    return nonce;
  } catch (error) {
    throw new Error(`Nonce fetch failed: ${error.message}`);
  }
}

// Main AI chat endpoint
async function getChatResponse(message, nonce) {
  const params = new URLSearchParams({
    action: 'ai_chat_response',
    message: message,
    nonce: nonce
  });

  const { statusCode, body } = await request('https://mistral-ai.chat/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: params.toString(),
    bodyTimeout: 30000,
    headersTimeout: 10000
  });

  if (statusCode !== 200) throw new Error(`API returned ${statusCode}`);

  return await body.json();
}

// API Routes
app.get('/api/chat', async (req, res) => {
  try {
    const userMessage = req.query.user || 'Hello';
    const systemPrompt = req.query.system || DEFAULT_SYSTEM;
    const message = `[SYSTEM]: ${systemPrompt} | [USER]: ${userMessage}`;

    const nonce = await fetchNonce();
    const response = await getChatResponse(message, nonce);

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.user || req.query.user || 'Hello';
    const systemPrompt = req.body.system || req.query.system || DEFAULT_SYSTEM;
    const message = `[SYSTEM]: ${systemPrompt} | [USER]: ${userMessage}`;

    const nonce = await fetchNonce();
    const response = await getChatResponse(message, nonce);

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    cache: cache.getStats()
  });
});

// OpenAPI Specification - MUST be defined BEFORE /docs route
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Jasmine AI Chat API',
      version: '1.0.0',
      description: 'High-performance AI chat API with automatic nonce management and caching',
      contact: {
        name: 'Ayan Sayyad',
        email: 'developer@example.com'
      }
    },
    servers: [
      { url: `http://localhost:${PORT}`, description: 'Development' },
      { url: 'https://your-domain.com', description: 'Production' }
    ],
    paths: {
      '/api/chat': {
        get: {
          summary: 'Get AI chat response',
          description: 'Send a message and get an AI response using GET request',
          parameters: [
            {
              name: 'user',
              in: 'query',
              required: false,
              schema: { type: 'string', default: 'Hello' },
              description: 'User message to send to the AI'
            },
            {
              name: 'system',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Custom system prompt (optional)'
            }
          ],
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object' },
                      timestamp: { type: 'string', format: 'date-time' }
                    }
                  },
                  example: {
                    success: true,
                    data: { response: 'Hey! I am Jasmine...' },
                    timestamp: '2025-11-15T09:14:00.000Z'
                  }
                }
              }
            },
            '429': { description: 'Rate limit exceeded' },
            '500': { description: 'Internal server error' }
          }
        },
        post: {
          summary: 'Post AI chat message',
          description: 'Send a message via POST with body or query params',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { type: 'string', example: 'Tell me about yourself' },
                    system: { type: 'string', example: 'You are a helpful assistant' }
                  }
                }
              },
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { type: 'string' },
                    system: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object' },
                      timestamp: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/health': {
        get: {
          summary: 'Health check',
          description: 'Check API health status and cache statistics',
          responses: {
            '200': {
              description: 'Healthy',
              content: {
                'application/json': {
                  example: {
                    status: 'healthy',
                    uptime: 12345.67,
                    cache: { keys: 1, hits: 45, misses: 3 }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

// Beautiful API Documentation with Scalar
app.use('/docs', apiReference({
  theme: 'purple',
  url: '/openapi.json',
}));

// Root redirect
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
  console.log(`📚 Docs available at http://localhost:${PORT}/docs`);
  console.log(`🏥 Health check at http://localhost:${PORT}/health`);
  console.log(`⚡ Powered by Undici (3-5x faster than Axios)`);
  console.log(`👨‍💻 Developed by Ayan Sayyad`);
});
