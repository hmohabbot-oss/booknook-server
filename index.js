const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://booknook-client-alpha.vercel.app',
    process.env.CLIENT_URL || ''
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const getDb = () => client.db("booknookDB");

app.get('/', (req, res) => {
  res.send('BookNook Server API is running smoothly on Vercel!');
});

app.get('/health', async (req, res) => {
  try {
    await client.db("admin").command({ ping: 1 });
    res.send({ status: "healthy", database: "connected", timestamp: new Date() });
  } catch (error) {
    res.status(500).send({ status: "unhealthy", error: error.message });
  }
});

// পুরনো N/A ইমেইলের বইগুলোকে বর্তমান ইউজারের নামে ফিক্স করার রুট
app.get('/fix-books', async (req, res) => {
  try {
    const targetEmail = (req.query.email || 'alimurtazamuaz@gmail.com').trim().toLowerCase();
    const targetName = req.query.name || 'Ali Murtaza';
    const booksCollection = getDb().collection("books");

    const result = await booksCollection.updateMany(
      {
        $or: [
          { userEmail: { $exists: false } },
          { userEmail: null },
          { userEmail: "" },
          { userEmail: "N/A" }
        ]
      },
      {
        $set: {
          userEmail: targetEmail,
          userName: targetName
        }
      }
    );

    res.send({
      success: true,
      message: `Successfully assigned ${result.modifiedCount} books to ${targetEmail}`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.post('/jwt', (req, res) => {
  const user = req.body;
  const token = jwt.sign(user, process.env.JWT_SECRET || 'booknook_jwt_secret_key_2026', { expiresIn: '7d' });
  res.send({ token });
});

// ১. GET /books
app.get('/books', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 0;
    const email = req.query.email;
    const query = {};
    
    if (email && email.trim() !== '') {
      query.userEmail = { $regex: new RegExp(`^${email.trim()}$`, 'i') };
    }

    const booksCollection = getDb().collection("books");
    let cursor = booksCollection.find(query).sort({ createdAt: -1 });
    if (limit > 0) cursor = cursor.limit(limit);

    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch books", error: error.message });
  }
});

// ২. GET /books/:id
app.get('/books/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const booksCollection = getDb().collection("books");
    const result = await booksCollection.findOne({ _id: new ObjectId(id) });
    if (!result) return res.status(404).send({ message: "Book not found" });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Invalid Book ID", error: error.message });
  }
});

// ৩. POST /books (ইমেইল ও নাম শতভাগ নিশ্চিত করে সেভ করা)
app.post('/books', async (req, res) => {
  try {
    const bookData = req.body;
    if (!bookData.title || !bookData.author || !bookData.category) {
      return res.status(400).send({ message: "Title, author, and category are mandatory fields." });
    }

    const copies = parseInt(bookData.totalCopies) || 1;
    const email = (bookData.userEmail || bookData.email || '').trim().toLowerCase();
    const name = bookData.userName || bookData.name || 'BookNook Reader';

    const newBook = {
      title: bookData.title,
      author: bookData.author,
      category: bookData.category,
      image: bookData.image,
      description: bookData.description,
      totalCopies: copies,
      availableCopies: copies,
      userEmail: email,
      userName: name,
      createdAt: new Date()
    };

    const booksCollection = getDb().collection("books");
    const result = await booksCollection.insertOne(newBook);
    res.status(201).send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to add book", error: error.message });
  }
});

// ৪. PATCH /books/:id
app.patch('/books/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updateData = req.body;
    const filter = { _id: new ObjectId(id) };

    const booksCollection = getDb().collection("books");
    const currentBook = await booksCollection.findOne(filter);
    if (!currentBook) return res.status(404).send({ message: "Book not found" });

    const newTotal = parseInt(updateData.totalCopies) || 1;
    const oldTotal = currentBook.totalCopies || newTotal;
    const oldAvailable = currentBook.availableCopies ?? oldTotal;

    const currentlyBorrowed = Math.max(0, oldTotal - oldAvailable);
    const newAvailable = Math.max(0, newTotal - currentlyBorrowed);

    const updateDoc = {
      $set: {
        title: updateData.title,
        author: updateData.author,
        category: updateData.category,
        image: updateData.image,
        description: updateData.description,
        totalCopies: newTotal,
        availableCopies: newAvailable,
        updatedAt: new Date()
      }
    };

    const result = await booksCollection.updateOne(filter, updateDoc);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to update book", error: error.message });
  }
});

// ৫. DELETE /books/:id
app.delete('/books/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const booksCollection = getDb().collection("books");
    const result = await booksCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to delete book", error: error.message });
  }
});

// ৬. POST /borrows
app.post('/borrows', async (req, res) => {
  try {
    const { bookId, userEmail, userName, returnDate } = req.body;
    const normalizedEmail = (userEmail || '').trim().toLowerCase();

    const borrowsCollection = getDb().collection("borrows");
    const booksCollection = getDb().collection("books");

    const alreadyBorrowed = await borrowsCollection.findOne({ 
      bookId, 
      userEmail: { $regex: new RegExp(`^${normalizedEmail}$`, 'i') } 
    });

    if (alreadyBorrowed) {
      return res.status(400).send({ message: "You have already borrowed this book and have not returned it yet." });
    }

    const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
    if (!book || book.availableCopies <= 0) {
      return res.status(400).send({ message: "This book is currently not available." });
    }

    const borrowRecord = {
      bookId,
      title: book.title,
      image: book.image,
      userEmail: normalizedEmail,
      userName,
      borrowDate: new Date().toISOString().split('T')[0],
      returnDate: returnDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      createdAt: new Date()
    };

    const insertResult = await borrowsCollection.insertOne(borrowRecord);
    await booksCollection.updateOne({ _id: new ObjectId(bookId) }, { $inc: { availableCopies: -1 } });

    res.status(201).send(insertResult);
  } catch (error) {
    res.status(500).send({ message: "Failed to borrow book", error: error.message });
  }
});

// ৭. GET /borrows
app.get('/borrows', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).send({ message: "User email is required" });

    const borrowsCollection = getDb().collection("borrows");
    const result = await borrowsCollection.find({ 
      userEmail: { $regex: new RegExp(`^${email.trim()}$`, 'i') } 
    }).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch borrows", error: error.message });
  }
});

// ৮. DELETE /borrows/:id
app.delete('/borrows/:id', async (req, res) => {
  try {
    const borrowId = req.params.id;
    const borrowsCollection = getDb().collection("borrows");
    const booksCollection = getDb().collection("books");

    const borrowRecord = await borrowsCollection.findOne({ _id: new ObjectId(borrowId) });
    if (!borrowRecord) return res.status(404).send({ message: "Borrow record not found" });

    await borrowsCollection.deleteOne({ _id: new ObjectId(borrowId) });
    await booksCollection.updateOne({ _id: new ObjectId(borrowRecord.bookId) }, { $inc: { availableCopies: 1 } });

    res.send({ message: "Book returned successfully" });
  } catch (error) {
    res.status(500).send({ message: "Failed to return book", error: error.message });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;