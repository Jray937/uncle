import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';

type Bindings = {
  CLERK_ISSUER_URL: string;
  'd1-binding': D1Database;
};

type Variables = {
  user: any;
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Enable CORS
app.use('/*', cors());

// Authentication Middleware
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  
  // Clerk's JWKS endpoint allows fetching the public keys to verify the token
  // If you use a custom domain, it might be https://auth.yourdomain.com/.well-known/jwks.json
  // Or simpler, set CLERK_ISSUER_URL env var to your Clerk Frontend API URL provided in dashboard
  const issuer = c.env.CLERK_ISSUER_URL; 

  try {
    // Determine JWKS URL based on issuer configuration
    // Clerk issuer usually looks like: https://clerk.your-app.com
    const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);

    const JWKS = createRemoteJWKSet(jwksUrl);
    
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: issuer,
    });

    // Attach user info to context
    c.set('user', payload);
    await next();
  } catch (error) {
    console.error('JWT Verification failed:', error);
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }
};

// Public Endpoint
app.get('/', (c) => {
  return c.text('Welcome to Uncle - The Trust Me Bro Backend (Powered by Clerk)!');
});

app.get('/api/public', (c) => {
  return c.json({ message: 'This is public data accessible to anyone.' });
});

// Health Check Endpoint
app.get('/api/health', async (c) => {
  try {
    // Verify database connection
    await c.env['d1-binding'].prepare('SELECT 1').first();
    
    return c.json({
      status: 'ok',
      message: 'Uncle backend is healthy',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Database connection failed';
    return c.json({
      status: 'error',
      message: 'Database connection failed',
      details: errorMessage
    }, 500);
  }
});

// Protected Endpoint
app.get('/api/private', authMiddleware, (c) => {
  const user = c.get('user');
  return c.json({ 
    message: 'Secure data accessed successfully!',
    user: {
      id: user.sub, // Clerk user ID
      // Clerk tokens don't always include email/name by default unless configured in JWT templates
      // but 'sub' is guaranteed.
      ...user
    }
  });
});

export default app;
