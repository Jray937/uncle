import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';

type Bindings = {
  CLERK_ISSUER_URL: string;
  TIINGO_API_TOKEN: string;
  'd1-binding': D1Database;
};

type Variables = {
  user: any;
}

interface Holding {
  id: number;
  user_id: string;
  symbol: string;
  name: string;
  shares: number;
  avg_price: number;
}

interface TiingoPrice {
  ticker: string;
  last: number;
  [key: string]: any;
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
app.get('/', async (c) => {
  let dbStatus = 'disconnected';
  try {
    await c.env['d1-binding'].prepare('SELECT 1').first();
    dbStatus = 'connected';
  } catch (error) {
    // DB connection failed, status remains 'disconnected'
  }
  return c.text(`Welcome to Uncle - The Trust Me Bro Backend (Powered by Clerk)! DB Status: ${dbStatus}`);
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

// Tiingo Search Endpoint
app.get('/api/search', authMiddleware, async (c) => {
  const query = c.req.query('query');
  if (!query) {
    return c.json({ error: 'Query parameter is required' }, 400);
  }

  const token = c.env.TIINGO_API_TOKEN;
  const url = `https://api.tiingo.com/tiingo/utilities/search?query=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Token ${token}`
      }
    });
    if (!response.ok) {
      return c.json({ error: 'Failed to fetch search results' }, 500);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Search request failed', details: errorMessage }, 500);
  }
});

// Get Holdings Endpoint
app.get('/api/holdings', authMiddleware, async (c) => {
  const user = c.get('user');
  const userId = user.sub;

  try {
    // Query holdings from D1
    const result = await c.env['d1-binding']
      .prepare('SELECT * FROM holdings WHERE user_id = ?')
      .bind(userId)
      .all();

    const holdings = (result.results || []) as unknown as Holding[];

    if (holdings.length === 0) {
      return c.json([]);
    }

    // Extract unique symbols
    const symbols = [...new Set(holdings.map((h: Holding) => h.symbol))].join(',');

    // Fetch current prices from Tiingo
    const token = c.env.TIINGO_API_TOKEN;
    const priceUrl = `https://api.tiingo.com/iex/?tickers=${symbols}`;

    const priceResponse = await fetch(priceUrl, {
      headers: {
        'Authorization': `Token ${token}`
      }
    });
    if (!priceResponse.ok) {
      // Return holdings without price data if Tiingo fails
      return c.json(holdings);
    }

    const priceData = await priceResponse.json() as TiingoPrice[];

    // Create a map of symbol to price
    const priceMap: Record<string, TiingoPrice> = {};
    if (Array.isArray(priceData)) {
      priceData.forEach((item: TiingoPrice) => {
        priceMap[item.ticker] = item;
      });
    }

    // Merge price data with holdings
    const enrichedHoldings = holdings.map((holding: Holding) => ({
      ...holding,
      currentPrice: priceMap[holding.symbol]?.last || null,
      priceData: priceMap[holding.symbol] || null
    }));

    return c.json(enrichedHoldings);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to fetch holdings', details: errorMessage }, 500);
  }
});

// Create Holdings Endpoint
app.post('/api/holdings', authMiddleware, async (c) => {
  const user = c.get('user');
  const userId = user.sub;

  try {
    const body = await c.req.json();
    const { symbol, name, shares, avg_price } = body;

    // Validate input
    if (!symbol || !name || shares === undefined || avg_price === undefined) {
      return c.json({ error: 'Missing required fields: symbol, name, shares, avg_price' }, 400);
    }

    if (typeof shares !== 'number' || typeof avg_price !== 'number') {
      return c.json({ error: 'shares and avg_price must be numbers' }, 400);
    }

    if (isNaN(shares) || !isFinite(shares) || isNaN(avg_price) || !isFinite(avg_price)) {
      return c.json({ error: 'shares and avg_price must be valid numbers' }, 400);
    }

    if (shares <= 0) {
      return c.json({ error: 'shares must be greater than 0' }, 400);
    }

    if (avg_price < 0) {
      return c.json({ error: 'avg_price must be non-negative' }, 400);
    }

    // Insert into D1
    const result = await c.env['d1-binding']
      .prepare('INSERT INTO holdings (user_id, symbol, name, shares, avg_price) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, symbol, name, shares, avg_price)
      .run();

    return c.json({ 
      success: true, 
      id: result.meta.last_row_id,
      message: 'Holding added successfully' 
    }, 201);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to create holding', details: errorMessage }, 500);
  }
});

// Delete Holdings Endpoint
app.delete('/api/holdings/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const userId = user.sub;
  const id = c.req.param('id');

  try {
    // Delete from D1 where id matches and user_id matches
    const result = await c.env['d1-binding']
      .prepare('DELETE FROM holdings WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Holding not found or unauthorized' }, 404);
    }

    return c.json({ success: true, message: 'Holding deleted successfully' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to delete holding', details: errorMessage }, 500);
  }
});

// Get News Endpoint
app.get('/api/news', authMiddleware, async (c) => {
  const user = c.get('user');
  const userId = user.sub;

  try {
    // Fetch holdings to get symbols
    const result = await c.env['d1-binding']
      .prepare('SELECT DISTINCT symbol FROM holdings WHERE user_id = ?')
      .bind(userId)
      .all();

    const holdings = result.results as Pick<Holding, 'symbol'>[] || [];

    if (holdings.length === 0) {
      return c.json([]);
    }

    // Extract unique symbols
    const symbols = holdings.map((h: Pick<Holding, 'symbol'>) => h.symbol).join(',');

    // Fetch news from Tiingo
    const token = c.env.TIINGO_API_TOKEN;
    const newsUrl = `https://api.tiingo.com/tiingo/news?tickers=${symbols}`;

    const newsResponse = await fetch(newsUrl, {
      headers: {
        'Authorization': `Token ${token}`
      }
    });
    if (!newsResponse.ok) {
      return c.json({ error: 'Failed to fetch news' }, 500);
    }

    const newsData = await newsResponse.json();
    return c.json(newsData);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to fetch news', details: errorMessage }, 500);
  }
});

export default app;
