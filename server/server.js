const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const yahooFinance = require('yahoo-finance2').default;
const { LinearRegression } = require('ml-regression');
const path = require('path'); // Add this for serving static files
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet()); // Security headers
app.use(cors({ origin: 'http://localhost:5000' })); // Allow frontend requests
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend from /public

// Rate limiting (100 req/min to prevent abuse)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use('/api/', limiter);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected successfully!'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema (for auth, watchlists, alerts)
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  watchlist: [{ type: String }], // e.g., ['AAPL', 'TSLA']
  alerts: [{ ticker: String, threshold: Number, type: String }] // e.g., {ticker: 'TSLA', threshold: 200, type: 'above'}
});
const User = mongoose.model('User ', userSchema);

// Auth Middleware (protect routes like watchlist)
const auth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ msg: 'Token is not valid' });
  }
};

// API Routes

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User  already exists' });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    user = new User({ email, password: hashedPassword, watchlist: [], alerts: [] });
    await user.save();
    const payload = { id: user.id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });
    const payload = { id: user.id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ msg: 'Server error' });
  }
});

// Get Stock History (for charts)
app.get('/api/stock/:ticker/history', async (req, res) => {
  const { ticker } = req.params;
  const days = parseInt(req.query.days) || 30;
  try {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const to = new Date();
    const data = await yahooFinance.historical(ticker, { period1: from, period2: to, interval: '1d' });
    res.json({ historical: data.map(d => ({ date: d.date, close: parseFloat(d.close) })) });
  } catch (err) {
    res.status(500).json({ msg: 'Error fetching stock data' });
  }
});

// Generate Prediction (Mock AI with linear regression)
app.post('/api/predict', async (req, res) => {
  const { ticker, horizon = 7 } = req.body; // Ignore market for now (add later if needed)
  try {
    // Fetch 30 days historical
    const histData = await yahooFinance.historical(ticker, { 
      period1: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 
      period2: new Date(), 
      interval: '1d' 
    });
    const closes = histData.map(d => parseFloat(d.close));
    const dates = histData.map((_, i) => i); // Indices as x for regression

    // Train simple linear model
    const model = new LinearRegression(dates, closes);
    const futureDates = Array.from({ length: horizon }, (_, i) => dates.length + i);
    const forecast = futureDates.map(date => model.predict(date));

    // Mock confidence, indicators, benchmark
    const confidence = Math.floor(85 + Math.random() * 10);
    const errorRange = `±${Math.floor(3 + Math.random() * 5)}%`;
    const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : closes[closes.length - 1];
    const rsi = Math.floor(50 + Math.random() * 40); // Mock 0-100
    const macd = Math.random() > 0.5 ? 'Bullish Crossover' : 'Bearish Divergence';

    // Benchmark vs S&P 500
    const sp500 = await yahooFinance.historical('^GSPC', { 
      period1: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), 
      period2: new Date(), 
      interval: '1d' 
    });
    const spChange = ((sp500[sp500.length - 1].close - sp500[0].close) / sp500[0].close) * 100;
    const tickerChange = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
    const outperformance = tickerChange - spChange;

    res.json({
      forecast,
      historical: histData.map(d => ({ date: d.date, close: parseFloat(d.close) })),
      confidence,
      errorRange,
      indicators: { ma50: parseFloat(ma50.toFixed(2)), rsi, macd },
      benchmark: { outperformance: parseFloat(outperformance.toFixed(2)) }
    });
  } catch (err) {
    console.error(err); // Log for debugging in VS Code terminal
    res.status(500).json({ msg: 'Error generating prediction' });
  }
});

// Sentiment (Mock – upgrade to real API later)
app.get('/api/sentiment/:ticker', (req, res) => {
  const { ticker } = req.params;
  const mockSentiments = {
    AAPL: { overall: 'Positive', score: 78, news: ['Apple Q4 Earnings Strong (+ impact)'], social: ['#AAPL trending bullish on Twitter'] },
    TSLA: { overall: 'Positive', score: 72, news: ['Tesla Q3 Earnings Beat Expectations (+ impact)'], social: ['#TSLA trending bullish on Twitter'] }
  };
  const sentiment = mockSentiments[ticker.toUpperCase()] || { overall: 'Neutral', score: 50, news: [], social: [] };
  res.json(sentiment);
});

// Get Watchlist (Auth required)
app.get('/api/user/watchlist', auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  res.json({ watchlist: user.watchlist });
});

// Add to Watchlist
app.post('/api/user/watchlist/add', auth, async (req, res) => {
  const { ticker } = req.body;
  const user = await User.findById(req.user.id);
  if (!user.watchlist.includes(ticker.toUpperCase())) {
    user.watchlist.push(ticker.toUpperCase());
    await user.save();
  }
  res.json({ watchlist: user.watchlist });
});

// Set Alert
app.post('/api/alerts/set', auth, async (req, res) => {
  const { ticker, threshold, type = 'above' } = req.body;
  const user = await User.findById(req.user.id);
  user.alerts.push({ ticker: ticker.toUpperCase(), threshold, type });
  await user.save();
  res.json({ msg: 'Alert set successfully' });
});

// Catch-all: Serve frontend for non-API routes
app.get('/:path(*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});