require("dotenv").config()
const jwt = require("jsonwebtoken")
const bcrypt = require("bcrypt")
const cookieParser = require('cookie-parser')
const express = require("express")
const db = require("better-sqlite3")("OurApp.db")
db.pragma("journal_mode = WAL")
const app = express()

const createTables = db.transaction(() => {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username STRING NOT NULL UNIQUE,
        password STRING NOT NULL
        )
        `).run()

    db.prepare(`
        CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        image TEXT,
        category TEXT
        )
        `).run()

    db.prepare(`
      CREATE TABLE IF NOT EXISTS discounts (
        code TEXT PRIMARY KEY,
        percent REAL NOT NULL
      )
    `).run()

})

createTables()

const seedDiscounts = db.transaction(() => {
  db.prepare("INSERT OR IGNORE INTO discounts (code, percent) VALUES (?, ?)").run("SAVE10", 10)
  db.prepare("INSERT OR IGNORE INTO discounts (code, percent) VALUES (?, ?)").run("FALL25", 25)
  db.prepare("INSERT OR IGNORE INTO discounts (code, percent) VALUES (?, ?)").run("WELCOME5", 5)
})

seedDiscounts()

const seedProducts = db.transaction(() => {
  const count = db.prepare("SELECT COUNT(*) AS total FROM products").get().total
  if (count > 0) return // Skip seeding if products already exist

  db.prepare(`
    INSERT INTO products (name, description, price, image, category)
    VALUES (?, ?, ?, ?, ?)
  `).run("Slim Fit Jeans", "Tapered denim with stretch comfort", 59.99, "/images/jeans.jpg", "Bottoms")

  db.prepare(`
    INSERT INTO products (name, description, price, image, category)
    VALUES (?, ?, ?, ?, ?)
  `).run("Oversized Hoodie", "Cozy fleece with front pocket", 44.99, "/images/hoodie.jpg", "Tops")

  db.prepare(`
    INSERT INTO products (name, description, price, image, category)
    VALUES (?, ?, ?, ?, ?)
  `).run("Graphic Tee", "Soft cotton with bold print", 24.99, "/images/tee.jpg", "Tops")
})

seedProducts()

app.set("view engine", "ejs")
app.use(express.urlencoded({extended: false}))
app.use(express.static("public"))
app.use(cookieParser())

const session = require("express-session")
app.use(session({
  secret: process.env.JWTSECRET || "fallback-secret",
  resave: false,
  saveUninitialized: false
}))

app.use(function (req, res, next) {
    res.locals.errors = []

    try {
        const decode = jwt.verify(req.cookies.Lucaria, process.env.JWTSECRET)
        req.user = decode
    } catch(err) {
        req.user = false
    }

    res.locals.user = req.user
    console.log(req.user)
    
    next()
})


app.get("/admin/products/new", (req, res) => {
  res.render("admin-new-product")
})

app.get("/", (req, res) => {
    if (req.user) {
        return res.render("dashboard")
    }
    res.render("homepage")
})

app.get("/login", (req, res) => {
    res.render("login")
})

app.get("/products", (req, res) => {
  const category = req.query.category
  const search = req.query.search?.trim()
  const sort = req.query.sort

  let products
  let baseQuery = "SELECT * FROM products"
  let conditions = []
  let params = []

  if (search) {
    conditions.push("(name LIKE ? OR description LIKE ?)")
    const like = `%${search}%`
    params.push(like, like)
  }

  if (category) {
    conditions.push("category = ?")
    params.push(category)
  }

  if (conditions.length > 0) {
    baseQuery += " WHERE " + conditions.join(" AND ")
  }

  if (sort === "low") {
    baseQuery += " ORDER BY price ASC"
  } else if (sort === "high") {
    baseQuery += " ORDER BY price DESC"
  }

  products = db.prepare(baseQuery).all(...params)

  res.render("products", { products, category, search, sort })
})

app.get("/products/:id", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id)

  if (!product) {
    return res.status(404).render("404")
  }

  res.render("product-detail", { product })
})

app.post("/admin/products/new", (req, res) => {
  const { name, price, category, description, image } = req.body
  db.prepare(`
    INSERT INTO products (name, price, category, description, image)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, price, category, description, image)
  res.redirect("/admin/products")
})

app.post("/cart/add", (req, res) => {
  const productId = parseInt(req.body.productId)
  const quantity = parseInt(req.body.quantity) || 1

  if (!productId || quantity < 1) return res.status(400).send("Invalid input")

  if (!req.session.cart) req.session.cart = []

  const existing = req.session.cart.find(item => item.productId === productId)
  if (existing) {
    existing.quantity += quantity
  } else {
    req.session.cart.push({ productId, quantity })
  }

  res.redirect("/cart")
})

app.post("/cart/remove", (req, res) => {
  const productId = parseInt(req.body.productId)

  if (!req.session.cart) req.session.cart = []

  req.session.cart = req.session.cart.filter(item => item.productId !== productId)

  if (req.session.cart.length === 0) {
    delete req.session.discount
    delete req.session.discountError
  }

  res.redirect("/cart")
})

app.get("/cart", (req, res) => {
  const cart = req.session.cart || []

  const products = cart.map(item => {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId)
    return {
      ...product,
      quantity: item.quantity,
      subtotal: product.price * item.quantity
    }
  })

  const subtotal = products.reduce((sum, p) => sum + p.subtotal, 0)
  const tax = subtotal * 0.0825

  let discountAmount = 0
  let discountCode = null

  if (req.session.discount) {
    discountAmount = subtotal * (req.session.discount.percent / 100)
    discountCode = req.session.discount.code
  }

  const total = subtotal + tax - discountAmount

  res.render("cart", {
    products,
    subtotal,
    tax,
    discountAmount,
    discountCode,
    total,
    discountError: req.session.discountError
})

})

app.post("/cart/apply-discount", (req, res) => {
  const code = req.body.discount?.trim().toUpperCase()
  if (!code) return res.redirect("/cart")

  const discount = db.prepare("SELECT * FROM discounts WHERE code = ?").get(code)
  if (!discount) {
    req.session.discountError = "Invalid discount code. Please try again."
    return res.redirect("/cart")
  }

  req.session.discount = discount
  delete req.session.discountError
  res.redirect("/cart")
})

app.get("/checkout", (req, res) => {
  const cart = req.session.cart || []

  const products = cart.map(item => {
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId)
    return {
      ...product,
      quantity: item.quantity,
      subtotal: product.price * item.quantity
    }
  })

  const subtotal = products.reduce((sum, p) => sum + p.subtotal, 0)
  const tax = subtotal * 0.0825

  let discountAmount = 0
  let discountCode = null

  if (req.session.discount) {
    discountAmount = subtotal * (req.session.discount.percent / 100)
    discountCode = req.session.discount.code
  }

  const total = subtotal + tax - discountAmount

  res.render("checkout", { products, subtotal, tax, discountAmount, discountCode, total })
})

app.get("/debug-jeans", (req, res) => {
  const jeans = db.prepare("SELECT * FROM products WHERE name = 'Slim Fit Jeans'").get()
  res.send(`<pre>${JSON.stringify(jeans, null, 2)}</pre>`)
})

app.get("/logout", (req,res) => {
    res.clearCookie("Lucaria")
    res.redirect("/")
})

app.post("/login", (req, res) => {
    let errors = []

    if (typeof req.body.username !== "string") req.body.username = ""
    if (typeof req.body.password !== "string") req.body.password = ""

    if (req.body.username.trim() == "") errors = ["Invalid username / password."]
    if (req.body.username == "") errors = ["Invalid username / password."]

    if (errors.length) {
        return res.render("login", {errors})
    }

    const userInQuestionStatement = db.prepare("SELECT * FROM users WHERE USERNAME = ?")
    const userInQuestion = userInQuestionStatement.get(req.body.username)

    if (!userInQuestion) {
        errors = ["Invalid username / password."]
        return res.render("login", {errors})
    }

    const matchOrNot = bcrypt.compareSync(req.body.password, userInQuestion.password)
    if (!matchOrNot) {
        errors = ["Invalid username / password."]
        return res.render("login", {errors})
    }

    const ourTokenValue = jwt.sign({exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,skyColor: "blue", userid: userInQuestion.id, username: userInQuestion.username}, process.env.JWTSECRET)

    res.cookie("Lucaria", ourTokenValue, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24
    })

    res.redirect("/")

})

app.post("/register", (req, res) =>{
    const errors = []

    if (typeof req.body.username !== "string") req.body.username = ""
    if (typeof req.body.password !== "string") req.body.password = ""

    req.body.username = req.body.username.trim()

    if (!req.body.username) errors.push("Enter a username.")
    if (req.body.username && req.body.username.length < 3) errors.push("Username must be at least 3 characters")
    if (req.body.username && req.body.username.length > 10) errors.push("Username cannot exceed 10 characters")
    if (req.body.username && !req.body.username.match(/^[a-zA-Z0-9]+$/)) errors.push("Username can only contain letters and numbers")

    const usernameStatement = db.prepare("SELECT * FROM users WHERE username = ?")
    const usernameCheck = usernameStatement.get(req.body.username)

    if(usernameCheck) errors.push("Username is taken.")

    if (!req.body.username) errors.push("Enter a password.")
    if (req.body.password && req.body.password.length < 12) errors.push("Password must be at least 12 characters")
    if (req.body.password && req.body.password.length > 70) errors.push("Password cannot exceed 70 characters")

    if (errors.length) {
        return res.render("homepage", {errors})
    } 
    
    const salt = bcrypt.genSaltSync(10)
    req.body.password = bcrypt.hashSync(req.body.password, salt)

   const ourStatement = db.prepare("INSERT INTO users (username, password) VALUES (?, ?)")
   const result = ourStatement.run(req.body.username, req.body.password)

   const lookupStatement = db.prepare("SELECT * FROM users WHERE ROWID = ?")
   const ourUser = lookupStatement.get(result.lastInsertRowid)


   const ourTokenValue = jwt.sign({exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,skyColor: "blue", userid: ourUser.id, username: ourUser.username}, process.env.JWTSECRET)

    res.cookie("Lucaria", ourTokenValue, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 1000 * 60 * 60 * 24
    })

    res.redirect("/")
})

app.listen(3000)