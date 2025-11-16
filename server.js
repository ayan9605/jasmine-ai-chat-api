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
const NODE_ENV = process.env.NODE_ENV || 'development';

// ===========================
// ENVIRONMENT VALIDATION
// ===========================
const requiredEnvVars = [];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// ===========================
// TRUST PROXY
// ===========================
app.set('trust proxy', true);

// ===========================
// SECURITY MIDDLEWARE
// ===========================
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
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  })
);

app.use(compression({ threshold: 1024 })); // Only compress responses > 1KB
app.use(express.json({ limit: '10mb' })); // Prevent huge payload attacks
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===========================
// CORS
// ===========================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ===========================
// RATE LIMITING
// ===========================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const excludedPaths = ['/docs', '/openapi.json', '/', '/health', '/metrics'];
    return excludedPaths.includes(req.path);
  },
  // Key generator to handle proxy IPs correctly
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress;
  }
});

app.use('/api/', limiter);

// ===========================
// CACHING
// ===========================
const cache = new NodeCache({ 
  stdTTL: 300, // 5 minutes
  checkperiod: 600, // 10 minutes
  useClones: false // Better performance
});

// ===========================
// REQUEST LOGGING (Production-friendly)
// ===========================
if (NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// ===========================
// DEFAULT SYSTEM PROMPT
// ===========================
const DEFAULT_SYSTEM = "I want you to act as a college student who is a girl in 18 years old and your name is Jasmine...";

// ===========================
// FETCH NONCE WITH CACHING
// ===========================
async function fetchNonce() {
  const cachedNonce = cache.get('nonce');
  if (cachedNonce) return cachedNonce;

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { statusCode, body } = await request('https://mistral-ai.chat/', {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        bodyTimeout: 10000,
        headersTimeout: 10000
      });

      if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);

      const html = await body.text();
      const nonceMatch = html.match(/nonce":"(.*?)"/);
      
      if (!nonceMatch) throw new Error('Nonce not found in HTML');

      const nonce = nonceMatch[1];
      cache.set('nonce', nonce, 3600); // Cache for 1 hour
      console.log('✅ Nonce fetched and cached successfully');
      return nonce;
    } catch (error) {
      lastError = error;
      console.error(`❌ Nonce fetch attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      }
    }
  }

  throw new Error(`Nonce fetch failed after ${maxRetries} attempts: ${lastError.message}`);
}

// ===========================
// MAIN AI CHAT ENDPOINT
// ===========================
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

// ===========================
// ASYNC HANDLER WRAPPER
// ===========================
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ===========================
// API ROUTES
// ===========================
app.get('/api/chat', asyncHandler(async (req, res) => {
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
}));

app.post('/api/chat', asyncHandler(async (req, res) => {
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
}));

// ===========================
// HEALTH & METRICS
// ===========================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    cache: cache.getStats(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  });
});

app.get('/metrics', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    uptime: process.uptime(),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
    },
    cache: cache.getStats(),
    nodeVersion: process.version,
    platform: process.platform
  });
});

// ===========================
// OPENAPI SPECIFICATION
// ===========================
app.get('/openapi.json', (req, res) => {
  const protocol = req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;

  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Jasmine AI Chat API',
      version: '1.0.0',
      description: 'High-performance AI chat API with automatic nonce management and caching',
      contact: {
        name: 'Ayan Sayyad'
      }
    },
    servers: [
      { 
        url: baseUrl,
        description: 'Current server'
      }
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
                    timestamp: '2025-11-16T11:35:00.000Z'
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
          description: 'Check API health status, cache statistics, and memory usage',
          responses: {
            '200': {
              description: 'Healthy',
              content: {
                'application/json': {
                  example: {
                    status: 'healthy',
                    uptime: 12345.67,
                    timestamp: '2025-11-16T11:35:00.000Z',
                    environment: 'production',
                    cache: { keys: 1, hits: 45, misses: 3 },
                    memory: { used: 50, total: 100 }
                  }
                }
              }
            }
          }
        }
      },
      '/metrics': {
        get: {
          summary: 'System metrics',
          description: 'Get detailed system metrics and performance data',
          responses: {
            '200': {
              description: 'System metrics',
              content: {
                'application/json': {
                  example: {
                    uptime: 12345.67,
                    memory: {
                      rss: '100 MB',
                      heapUsed: '50 MB',
                      heapTotal: '100 MB',
                      external: '5 MB'
                    },
                    cache: { keys: 1, hits: 45, misses: 3 },
                    nodeVersion: 'v20.10.0',
                    platform: 'linux'
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

// ===========================
// API DOCUMENTATION
// ===========================
app.use('/docs', apiReference({
  theme: 'purple',
  url: '/openapi.json',
}));

// ===========================
// ROOT REDIRECT
// ===========================
app.get('/', (req, res) => {
  res.redirect('/docs');
});

// ===========================
// 404 HANDLER
// ===========================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path,
    timestamp: new Date().toISOString()
  });
});

// ===========================
// GLOBAL ERROR HANDLER
// ===========================
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);

  // Don't leak error details in production
  const isDev = NODE_ENV !== 'production';

  res.status(err.status || 500).json({
    success: false,
    error: isDev ? err.message : 'Internal server error',
    ...(isDev && { stack: err.stack }),
    timestamp: new Date().toISOString()
  });
});

// ===========================
// GRACEFUL SHUTDOWN
// ===========================
let server;
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 ${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close cache
    cache.close();
    console.log('✅ Cache closed');
    
    // Exit process
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('❌ Forceful shutdown after timeout');
    process.exit(1);
  }, 30000);
}

// Listen for termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// ===========================
// START SERVER
// ===========================
server = app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Jasmine AI Chat API`);
  console.log(`${'='.repeat(60)}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`🔗 Server: http://localhost:${PORT}`);
  console.log(`📚 Docs: http://localhost:${PORT}/docs`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
  console.log(`⚡ Runtime: Node.js ${process.version}`);
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  console.log(`👨‍💻 Developed by Ayan Sayyad`);
  console.log(`${'='.repeat(60)}\n`);
});

// Set server timeout to prevent hanging connections
server.setTimeout(60000); // 60 seconds

export default app;
