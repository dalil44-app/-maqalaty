const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Error:', err));

// User Schema
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: String,
  googleId: String,
  name: String,
  avatar: String,
  balance: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  subscribers: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Article Schema
const ArticleSchema = new mongoose.Schema({
  title: String,
  content: String,
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: String,
  authorAvatar: String,
  image: String,
  category: { type: String, default: 'general' },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  earnings: { type: Number, default: 0 },
  youtubeUrl: String,
  status: { type: String, default: 'published' },
  createdAt: { type: Date, default: Date.now }
});

// Comment Schema
const CommentSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article' },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: String,
  authorAvatar: String,
  text: String,
  likes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Article = mongoose.model('Article', ArticleSchema);
const Comment = mongoose.model('Comment', CommentSchema);

// Auth Middleware
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, name });
    await user.save();
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user: { id: user._id, name, email, avatar: null } });
  } catch (e) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) {
      throw new Error();
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user: { id: user._id, name: user.name, email, avatar: user.avatar } });
  } catch (e) {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Google Auth
app.post('/api/auth/google', async (req, res) => {
  try {
    const { googleId, email, name, avatar } = req.body;
    let user = await User.findOne({ googleId });
    if (!user) {
      user = new User({ googleId, email, name, avatar });
      await user.save();
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user: { id: user._id, name, email, avatar } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Get Articles
app.get('/api/articles', async (req, res) => {
  const { category, search, page = 1 } = req.query;
  let query = { status: 'published' };
  
  if (category && category !== 'all') query.category = category;
  if (search) query.title = { $regex: search, $options: 'i' };
  
  const articles = await Article.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * 20)
    .limit(20);
  
  res.json(articles);
});

// Get Single Article
app.get('/api/articles/:id', async (req, res) => {
  const article = await Article.findByIdAndUpdate(
    req.params.id,
    { $inc: { views: 1 } },
    { new: true }
  );
  
  if (article) {
    article.earnings = (article.views / 1000) * 1;
    await article.save();
  }
  
  res.json(article);
});

// Create Article
app.post('/api/articles', auth, async (req, res) => {
  const { title, content, image, category } = req.body;
  const article = new Article({
    title,
    content,
    image,
    category,
    author: req.user._id,
    authorName: req.user.name,
    authorAvatar: req.user.avatar
  });
  await article.save();
  res.json(article);
});

// Convert YouTube to Article
app.post('/api/articles/youtube', auth, async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    const videoId = extractVideoId(youtubeUrl);
    
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
    const videoResponse = await youtube.videos.list({
      part: 'snippet,contentDetails',
      id: videoId
    });

    if (!videoResponse.data.items.length) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = videoResponse.data.items[0];
    const title = video.snippet.title;
    const description = video.snippet.description;
    const thumbnail = video.snippet.thumbnails.maxres?.url || 
                     video.snippet.thumbnails.high?.url || 
                     video.snippet.thumbnails.default.url;

    const content = `
      <p><strong>Article extracted from YouTube video</strong></p>
      <p>Original title: ${title}</p>
      <p>Video URL: <a href="${youtubeUrl}" target="_blank">${youtubeUrl}</a></p>
      <hr>
      <h2>Video Description</h2>
      <p>${description.replace(/\\n/g, '</p><p>')}</p>
      <blockquote>Note: This content was automatically extracted.</blockquote>
    `;

    const article = new Article({
      title: `Article: ${title}`,
      content,
      image: thumbnail,
      youtubeUrl,
      category: 'general',
      author: req.user._id,
      authorName: req.user.name,
      authorAvatar: req.user.avatar,
      status: 'published'
    });

    await article.save();
    res.json(article);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to convert video' });
  }
});

// Get Comments
app.get('/api/articles/:id/comments', async (req, res) => {
  const comments = await Comment.find({ article: req.params.id })
    .sort({ createdAt: -1 });
  res.json(comments);
});

// Add Comment
app.post('/api/articles/:id/comments', auth, async (req, res) => {
  const comment = new Comment({
    article: req.params.id,
    author: req.user._id,
    authorName: req.user.name,
    authorAvatar: req.user.avatar,
    text: req.body.text
  });
  await comment.save();
  res.json(comment);
});

// Dashboard Stats
app.get('/api/dashboard', auth, async (req, res) => {
  const userArticles = await Article.find({ author: req.user._id });
  const totalViews = userArticles.reduce((sum, a) => sum + a.views, 0);
  const totalEarnings = userArticles.reduce((sum, a) => sum + a.earnings, 0);
  
  res.json({
    stats: {
      views: totalViews,
      earnings: totalEarnings.toFixed(2),
      articles: userArticles.length,
      subscribers: req.user.subscribers
    },
    articles: userArticles
  });
});

// Withdraw Earnings
app.post('/api/withdraw', auth, async (req, res) => {
  const { amount } = req.body;
  if (req.user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  req.user.balance -= amount;
  await req.user.save();
  res.json({ message: 'Withdrawal request sent', balance: req.user.balance });
});

function extractVideoId(url) {
  const regExp = /^.*(youtu.be\\/|v\\/|u\\/\\w\\/|embed\\/|watch\\?v=|\\&v=)([^#\\&\\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
