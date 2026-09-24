const http = require("http");
const { handle } = require("./lib/routes");
const { sendError } = require("./lib/helpers");

const PORT = Number(process.env.PORT || 3019);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => sendError(res, error));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
