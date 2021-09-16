/**
 * Entry point. It serves the data, and reinstalls the code.
 */
const express = require('express')


const app = express()
const port = 4000;

app.use(express.static('public'))

app.get('/', (_req, res) => {
  res.send('PolkaFantasy Grant list!')
})

app.listen(port, () => {
    try {
        let sync = require('./sync');
        sync.SyncByUpdate();
    } catch (e) {
        process.exit(1);
    }
    console.log(`Listening at http://localhost:${port}`)
})