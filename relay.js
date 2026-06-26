const Gun = require('gun');
const http = require('http');

const port = process.env.PORT || 8765;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('PipChat Gun relay OK');
});

Gun({ web: server, localStorage: false, radisk: false });

server.listen(port, () => {
  console.log('Gun relay on port ' + port);
});
