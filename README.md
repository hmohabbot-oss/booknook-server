# 🚀 BookNook Server API

Robust Express.js and MongoDB backend powering the BookNook community library.

## 📌 Features & API Routes

- `GET /` - Root health check confirming serverless deployment status
- `GET /health` - Database ping and server health monitoring
- `POST /jwt` - Generate secure JWT access tokens for protected resources
- `GET /books` - Retrieve all books (supports `?limit=6` and `?email=...` query filters)
- `GET /books/:id` - Fetch single book details
- `POST /books` - Add a new book with payload validation
- `PATCH /books/:id` - Update book details and automatically sync available copies
- `DELETE /books/:id` - Remove a book from the library catalog
- `POST /borrows` - Borrow a book (includes no-double-borrow validation and `$inc: -1`)
- `GET /borrows` - Retrieve borrowed books for a specific reader
- `DELETE /borrows/:id` - Return a borrowed book and restore stock count (`$inc: 1`)

## 🛠️ Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB Atlas (Native Driver)
- **Authentication:** JSON Web Token (JWT)
- **Deployment:** Vercel Serverless Functions