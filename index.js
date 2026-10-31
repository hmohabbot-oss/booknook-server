const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: [process.env.CLIENT_URL || 'http://localhost:3000'],
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

// JWT ভেরিফিকেশন মিডলওয়্যার (চ্যালেঞ্জ রিকোয়ারমেন্ট)
const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return res.status(401).send({ error: true, message: 'Unauthorized access: No token provided' });
  }
  const token = authorization.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'booknook_jwt_secret_key_2026', (err, decoded) => {
    if (err) {
      return res.status(403).send({ error: true, message: 'Forbidden access: Invalid token' });
    }
    req.decoded = decoded;
    next();
  });
};

async function run() {
  try {
    await client.connect();
    const db = client.db("booknookDB");
    const booksCollection = db.collection("books");
    const borrowsCollection = db.collection("borrows");

    console.log("BookNook MongoDB Collections Ready!");

    // বেসিক রুট
    app.get('/', (req, res) => {
      res.send('BookNook Server API is running smoothly!');
    });

    // সার্ভার ও ডাটাবেজ হেলথ চেক
    app.get('/health', async (req, res) => {
      try {
        await client.db("admin").command({ ping: 1 });
        res.send({ status: "healthy", database: "connected", timestamp: new Date() });
      } catch (error) {
        res.status(500).send({ status: "unhealthy", error: error.message });
      }
    });

    // JWT টোকেন জেনারেট রুট
    app.post('/jwt', (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET || 'booknook_jwt_secret_key_2026', { expiresIn: '7d' });
      res.send({ token });
    });

    // ==========================================
    // BOOKS API ROUTES
    // ==========================================

    // ১. GET /books - সব বই দেখা অথবা ইমেইল ফিল্টার অনুযায়ী বই দেখা
    app.get('/books', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 0;
        const email = req.query.email;
        const query = {};
        
        if (email) {
          query.userEmail = email;
        }
        
        let cursor = booksCollection.find(query).sort({ createdAt: -1 });
        if (limit > 0) {
          cursor = cursor.limit(limit);
        }
        
        const result = await cursor.toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch books", error: error.message });
      }
    });

    // ২. GET /books/:id - একটি নির্দিষ্ট বই
    app.get('/books/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const result = await booksCollection.findOne({ _id: new ObjectId(id) });
        if (!result) return res.status(404).send({ message: "Book not found" });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Invalid Book ID", error: error.message });
      }
    });

    // ৩. POST /books - নতুন বই তৈরি
    app.post('/books', async (req, res) => {
      try {
        const bookData = req.body;
        
        // Payload validation
        if (!bookData.title || !bookData.author || !bookData.category) {
          return res.status(400).send({ message: "Title, author, and category are mandatory fields." });
        }

        const copies = parseInt(bookData.totalCopies) || 1;
        
        const newBook = {
          title: bookData.title,
          author: bookData.author,
          category: bookData.category,
          image: bookData.image,
          description: bookData.description,
          totalCopies: copies,
          availableCopies: copies,
          userEmail: bookData.userEmail,
          userName: bookData.userName,
          createdAt: new Date()
        };

        const result = await booksCollection.insertOne(newBook);
        res.status(201).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to add book", error: error.message });
      }
    });

    // ৪. PATCH /books/:id - বই আপডেট করা (স্মার্ট কপি ব্যালেন্সিং সহ)
    app.patch('/books/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const updateData = req.body;
        const filter = { _id: new ObjectId(id) };

        const currentBook = await booksCollection.findOne(filter);
        if (!currentBook) {
          return res.status(404).send({ message: "Book not found" });
        }

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

    // ৫. DELETE /books/:id - বই ডিলিট করা
    app.delete('/books/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const result = await booksCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete book", error: error.message });
      }
    });

    // ==========================================
    // BORROW SYSTEM API ROUTES
    // ==========================================

    // ৬. POST /borrows - বই ধার নেওয়া
    app.post('/borrows', async (req, res) => {
      try {
        const { bookId, userEmail, userName, returnDate } = req.body;

        const alreadyBorrowed = await borrowsCollection.findOne({
          bookId: bookId,
          userEmail: userEmail
        });

        if (alreadyBorrowed) {
          return res.status(400).send({
            message: "You have already borrowed this book and have not returned it yet."
          });
        }

        const book = await booksCollection.findOne({ _id: new ObjectId(bookId) });
        if (!book || book.availableCopies <= 0) {
          return res.status(400).send({ message: "This book is currently not available." });
        }

        const borrowRecord = {
          bookId: bookId,
          title: book.title,
          image: book.image,
          userEmail: userEmail,
          userName: userName,
          borrowDate: new Date().toISOString().split('T')[0],
          returnDate: returnDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          createdAt: new Date()
        };

        const insertResult = await borrowsCollection.insertOne(borrowRecord);

        await booksCollection.updateOne(
          { _id: new ObjectId(bookId) },
          { $inc: { availableCopies: -1 } }
        );

        res.status(201).send(insertResult);
      } catch (error) {
        res.status(500).send({ message: "Failed to borrow book", error: error.message });
      }
    });

    // ৭. GET /borrows - ইউজারের ধার নেওয়া বইয়ের তালিকা
    app.get('/borrows', async (req, res) => {
      try {
        const email = req.query.email;
        if (!email) return res.status(400).send({ message: "User email is required" });

        const result = await borrowsCollection.find({ userEmail: email }).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch borrows", error: error.message });
      }
    });

    // ৮. DELETE /borrows/:id - বই ফেরত দেওয়া
    app.delete('/borrows/:id', async (req, res) => {
      try {
        const borrowId = req.params.id;
        const borrowRecord = await borrowsCollection.findOne({ _id: new ObjectId(borrowId) });

        if (!borrowRecord) return res.status(404).send({ message: "Borrow record not found" });

        await borrowsCollection.deleteOne({ _id: new ObjectId(borrowId) });

        await booksCollection.updateOne(
          { _id: new ObjectId(borrowRecord.bookId) },
          { $inc: { availableCopies: 1 } }
        );

        res.send({ message: "Book returned successfully" });
      } catch (error) {
        res.status(500).send({ message: "Failed to return book", error: error.message });
      }
    });

    // 404 Route Handler
    app.use((req, res) => {
      res.status(404).send({ message: "Route not found on BookNook API server" });
    });

  } catch (error) {
    console.error("MongoDB Server Error:", error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`BookNook Server is running on port ${port}`);
});