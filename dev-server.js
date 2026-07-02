// Local development entry point. Vercel never runs this file — it invokes
// api/index.js directly as a serverless function. This just wraps that same
// Express app with .listen() so you can run `npm run dev` on your own machine
// and hit it at http://localhost:3000, using a local .env file for credentials.
require("dotenv").config();
const app = require("./api/index.js");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MySunshineCo (dev) running at http://localhost:${PORT}`);
});
