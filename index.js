const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 5000);
const uri = process.env.MONGODB_URI;
const jwtSecret = process.env.JWT_SECRET;
const jwtIssuer = process.env.JWT_ISSUER || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const jwtAudience = process.env.JWT_AUDIENCE || 'booknook-api';

if (!uri) throw new Error('MONGODB_URI must be configured.');
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be configured with at least 32 characters.');

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json({ limit: '1mb' }));

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

function verifyJWT(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).send({ message: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'], audience: jwtAudience, issuer: jwtIssuer,
    });
    if (!req.user.sub || !req.user.email) throw new Error('Token has no user identity');
    next();
  } catch {
    return res.status(401).send({ message: 'Session expired or invalid. Please sign in again.' });
  }
}

function validId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) && ObjectId.isValid(value);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function run() {
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE || 'booknookDB');
  const books = db.collection('books');
  const borrows = db.collection('borrows');
  await borrows.createIndex({ bookId: 1, userEmail: 1 }, { unique: true, name: 'one_active_borrow_per_user_book' });

  // GET /books is public. mine=true returns only the authenticated user's books.
  app.get('/books', (req, res, next) => req.query.mine === 'true' ? verifyJWT(req, res, next) : next(), async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 0, 0), 100);
      const query = req.query.mine === 'true' ? { userEmail: req.user.email } : {};
      let cursor = books.find(query).sort({ createdAt: -1 });
      if (limit) cursor = cursor.limit(limit);
      res.send(await cursor.toArray());
    } catch (error) {
      console.error('GET /books failed:', error);
      res.status(500).send({ message: 'Failed to fetch books' });
    }
  });

  // Book details are a private route.
  app.get('/books/:id', verifyJWT, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid book ID' });
    try {
      const book = await books.findOne({ _id: new ObjectId(req.params.id) });
      if (!book) return res.status(404).send({ message: 'Book not found' });
      res.send(book);
    } catch (error) {
      console.error('GET /books/:id failed:', error);
      res.status(500).send({ message: 'Failed to fetch book' });
    }
  });

  // Only the authenticated user can create a book in their own name.
  app.post('/books', verifyJWT, async (req, res) => {
    const { title, author, category, image, description } = req.body || {};
    const totalCopies = positiveInteger(req.body?.totalCopies);
    const categories = ['Fiction', 'Science', 'History', 'Kids', 'Others'];
    if (!title?.trim() || !author?.trim() || !categories.includes(category) || !image?.trim() || !description?.trim() || !totalCopies) {
      return res.status(400).send({ message: 'Provide a title, author, valid category, image, description, and positive copy count.' });
    }
    try {
      const result = await books.insertOne({
        title: title.trim(), author: author.trim(), category, image: image.trim(), description: description.trim(),
        totalCopies, availableCopies: totalCopies, userEmail: req.user.email, userName: req.user.name || '', createdAt: new Date(),
      });
      res.status(201).send({ insertedId: result.insertedId });
    } catch (error) {
      console.error('POST /books failed:', error);
      res.status(500).send({ message: 'Failed to add book' });
    }
  });

  // Only the book's owner can update it. Never trust ownership fields from the browser.
  app.patch('/books/:id', verifyJWT, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid book ID' });
    const { title, author, category, image, description } = req.body || {};
    const totalCopies = positiveInteger(req.body?.totalCopies);
    const categories = ['Fiction', 'Science', 'History', 'Kids', 'Others'];
    if (!title?.trim() || !author?.trim() || !categories.includes(category) || !image?.trim() || !description?.trim() || !totalCopies) {
      return res.status(400).send({ message: 'Book details or copy count are invalid.' });
    }
    try {
      const filter = { _id: new ObjectId(req.params.id), userEmail: req.user.email };
      const current = await books.findOne(filter);
      if (!current) return res.status(404).send({ message: 'Book not found or you do not own it' });
      const borrowed = (current.totalCopies || 0) - (current.availableCopies ?? current.totalCopies ?? 0);
      if (totalCopies < borrowed) return res.status(409).send({ message: `At least ${borrowed} copies are currently borrowed.` });
      const result = await books.updateOne(filter, { $set: {
        title: title.trim(), author: author.trim(), category, image: image.trim(), description: description.trim(),
        totalCopies, availableCopies: totalCopies - borrowed, updatedAt: new Date(),
      } });
      if (!result.matchedCount) return res.status(404).send({ message: 'Book not found or you do not own it' });
      res.send({ modifiedCount: result.modifiedCount });
    } catch (error) {
      console.error('PATCH /books/:id failed:', error);
      res.status(500).send({ message: 'Failed to update book' });
    }
  });

  // Do not remove a book while copies are on loan.
  app.delete('/books/:id', verifyJWT, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid book ID' });
    try {
      const filter = { _id: new ObjectId(req.params.id), userEmail: req.user.email };
      const book = await books.findOne(filter);
      if (!book) return res.status(404).send({ message: 'Book not found or you do not own it' });
      if (await borrows.findOne({ bookId: req.params.id })) {
        return res.status(409).send({ message: 'This book has active loans and cannot be deleted yet.' });
      }
      const result = await books.deleteOne(filter);
      res.send({ deletedCount: result.deletedCount });
    } catch (error) {
      console.error('DELETE /books/:id failed:', error);
      res.status(500).send({ message: 'Failed to delete book' });
    }
  });

  // Atomic stock claim plus unique index prevent overselling and double borrowing.
  app.post('/borrows', verifyJWT, async (req, res) => {
    const { bookId, returnDate } = req.body || {};
    if (!validId(bookId)) return res.status(400).send({ message: 'Invalid book ID' });
    if (returnDate && (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || new Date(`${returnDate}T00:00:00`) <= new Date(new Date().toDateString()))) {
      return res.status(400).send({ message: 'Return date must be a future date.' });
    }
    const session = client.startSession();
    try {
      let recordId;
      await session.withTransaction(async () => {
        const id = new ObjectId(bookId);
        const book = await books.findOneAndUpdate(
          { _id: id, availableCopies: { $gt: 0 } },
          { $inc: { availableCopies: -1 } },
          { returnDocument: 'after', session },
        );
        if (!book) throw Object.assign(new Error('This book is currently not available.'), { status: 409 });
        const borrow = {
          bookId, title: book.title, image: book.image, userEmail: req.user.email, userName: req.user.name || '',
          borrowDate: new Date().toISOString().slice(0, 10),
          returnDate: returnDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
          createdAt: new Date(),
        };
        const inserted = await borrows.insertOne(borrow, { session });
        recordId = inserted.insertedId;
      });
      res.status(201).send({ insertedId: recordId });
    } catch (error) {
      if (error.code === 11000) return res.status(409).send({ message: 'You already have this book borrowed.' });
      if (error.status) return res.status(error.status).send({ message: error.message });
      console.error('POST /borrows failed:', error);
      res.status(500).send({ message: 'Failed to borrow book' });
    } finally {
      await session.endSession();
    }
  });

  app.get('/borrows', verifyJWT, async (req, res) => {
    try {
      res.send(await borrows.find({ userEmail: req.user.email }).sort({ createdAt: -1 }).toArray());
    } catch (error) {
      console.error('GET /borrows failed:', error);
      res.status(500).send({ message: 'Failed to fetch borrows' });
    }
  });

  // A borrower can only return their own record; both changes commit together.
  app.delete('/borrows/:id', verifyJWT, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).send({ message: 'Invalid borrow ID' });
    const session = client.startSession();
    try {
      let returned = false;
      await session.withTransaction(async () => {
        const record = await borrows.findOneAndDelete(
          { _id: new ObjectId(req.params.id), userEmail: req.user.email }, { session },
        );
        if (!record) return;
        const bookUpdate = await books.updateOne(
          { _id: new ObjectId(record.bookId), $expr: { $lt: ['$availableCopies', '$totalCopies'] } },
          { $inc: { availableCopies: 1 } }, { session },
        );
        if (!bookUpdate.matchedCount) throw new Error('Book stock could not be restored; return was cancelled.');
        returned = true;
      });
      if (!returned) return res.status(404).send({ message: 'Borrow record not found or it belongs to another user' });
      res.send({ message: 'Book returned successfully' });
    } catch (error) {
      console.error('DELETE /borrows/:id failed:', error);
      res.status(500).send({ message: error.message || 'Failed to return book' });
    } finally {
      await session.endSession();
    }
  });

  app.use((req, res) => res.status(404).send({ message: 'Route not found on BookNook API server' }));
  app.listen(port, () => console.log(`BookNook API listening on port ${port}`));
}

run().catch((error) => {
  console.error('BookNook startup failed:', error.message);
  process.exit(1);
});
