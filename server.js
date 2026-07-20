const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.post('/api/test', (req, res) => {
    res.send('Test endpoint');
});

app.post('/api/test2', (req, res) => {
    res.send('Test endpoint 2');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
