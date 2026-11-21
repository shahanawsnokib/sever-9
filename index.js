import express from 'express'
import cors from 'cors'
import { MongoClient } from 'mongodb';
import 'dotenv/config'

const app = express()
const port = process.env.PORT || 5000;
//MIDDLEWARE

app.use(express.json())
app.use(cors())


const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB()
const database = connectedClient.db("machineRentbd")
const users = database.collection("user")

app.get('/', (req, res)=> {
    res.send("Hello Dear!!")
})


app.get('/users', async(req, res) => {
  const cursor = users.find({});
  const allValues = await cursor.toArray()
  res.send(allValues)
  console.log(allValues);
  
})



app.listen(port, ()=> {
    console.log(`Ther server is runnig on port ${port}`)
})

