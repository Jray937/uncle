import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';

type Bindings = {
  KEYCLOAK_ISSUER: string;
  KEYCLOAK_AUDIENCE: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS
app.use('/*', cors());

// Authentication Middleware
const authMiddleware = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid token' }, 401);
  }

  const token = authHeader.split(' ')[1];
  const issuer = c.env.KEYCLOAK_ISSUER;
  
  // Construct the JWKS URL from the issuer
  const jwksUrl = new URL(
    `${issuer}/protocol/openid-connect/certs`
  );

  try {
    const JWKS = createRemoteJWKSet(jwksUrl);
    
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: issuer,
      // audience: c.env.KEYCLOAK_AUDIENCE, // Uncomment to verify audience if needed
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
  return c.text('Welcome to Uncle - The Trust Me Bro Backend!');
});

app.get('/api/public', (c) => {
  return c.json({ message: 'This is public data accessible to anyone.' });
});

// Protected Endpoint
app.get('/api/private', authMiddleware, (c) => {
  const user = c.get('user');
  return c.json({ 
    message: 'Secure data accessed successfully!',
    user: {
      sub: user.sub,
      name: user.name,
      email: user.email,
      roles: user.realm_access?.roles || []
    }
  });
});

export default app;
