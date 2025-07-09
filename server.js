require("dotenv").config();

const express = require("express");
const app = express();

const cors = require("cors");

const port = process.env.PORT || 4000;
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",");
const mongoUri = process.env.MONGODB_URI;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

/*****************************************Socket.io***************************************************/

const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: process.env.SOCKET_ORIGIN.split(","),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Store socket connections with user identifiers
const userSockets = new Map();

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle user identification
  socket.on("identify", (userId) => {
    try {
      console.log("User identified:", userId);
      userSockets.set(userId, socket);

      // Acknowledge successful identification
      socket.emit("identified", { success: true });
    } catch (error) {
      console.error("Error during user identification:", error);
      socket.emit("error", { message: "Failed to identify user" });
    }
  });
});

/*****************************************MongoDB***************************************************/

const { MongoClient, ServerApiVersion } = require("mongodb");

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.post("/save-lesson", async (req, res) => {
  try {
    const { lesson, unit, teacher } = req.body;

    // --- 1. Save the lesson to the "Lessons" collection (for flat searching) ---
    const lessonDocument = {
      teacher,
      unit,
      lesson,
      createdAt: new Date(),
    };
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");
    const lessonInsertResult =
      await lessonsCollection.insertOne(lessonDocument);

    console.log(
      `Lesson saved to 'Lessons' collection with id: ${lessonInsertResult.insertedId}`
    );

    // --- 2. Update the teacher's document in the "Teachers" collection ---
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Step 2a: Try to push the lesson into an existing unit's 'lessons' array.
    const updateResult = await teachersCollection.updateOne(
      { name: teacher, "units.value": unit.value },
      { $push: { "units.$.lessons": lesson } }
    );

    // Step 2b: If the unit didn't exist for that teacher, add the new unit to the teacher's 'units' array.
    if (updateResult.matchedCount === 0) {
      // This update handles cases where the 'units' array exists but the specific unit doesn't,
      // or where the 'units' array doesn't exist at all.
      const addUnitResult = await teachersCollection.updateOne(
        { name: teacher },
        { $push: { units: { ...unit, lessons: [lesson] } } }
      );

      // If this second update also fails to find a match, it means the teacher doesn't exist.
      if (addUnitResult.matchedCount === 0) {
        console.warn(
          `Teacher '${teacher}' not found in 'Teachers' collection. Lesson was saved to 'Lessons' but not added to a teacher profile.`
        );
      }
    }

    console.log(
      `Lesson added to unit '${unit.name}' for teacher '${teacher}'.`
    );

    res
      .status(201)
      .json({ success: true, lessonId: lessonInsertResult.insertedId });
  } catch (error) {
    console.error("Failed to save lesson:", error);
    res.status(500).json({ success: false, message: "Failed to save lesson." });
  }
});

app.post("/upload-whirlpool", (req, res) => {
  try {
    // For now, we are just logging the lesson object that is received.
    const { lesson } = req.body;

    console.log("--- Received /upload-whirlpool request ---");
    if (lesson) {
      console.log(
        "Lesson to be uploaded to Whirlpool:",
        JSON.stringify(lesson, null, 2)
      );
    } else {
      console.log(
        "Received data for Whirlpool, but 'lesson' object not found. Full body:",
        JSON.stringify(req.body, null, 2)
      );
    }
    console.log("------------------------------------------");

    res
      .status(200)
      .json({ success: true, message: "Lesson received and logged." });
  } catch (error) {
    console.error("Error in /upload-whirlpool endpoint:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process Whirlpool upload request.",
    });
  }
});

app.post("/test-lesson", async (req, res) => {
  try {
    // Destructure the teacher name, unit name, and lesson title from the request body
    const { teacher, unitName, lessonTitle } = req.body;

    // Basic validation
    if (!teacher || !unitName || !lessonTitle) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: teacher, unitName, lessonTitle",
      });
    }

    console.log(
      `Searching for lesson with Title: "${lessonTitle}", Unit: "${unitName}", Teacher: "${teacher}"`
    );

    // Construct the query to find the specific lesson
    const query = {
      teacher: teacher,
      "unit.name": unitName,
      "lesson.lesson_title": lessonTitle,
    };

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");
    const lessonDocument = await lessonsCollection.findOne(query);

    if (lessonDocument) {
      console.log("--- Found Lesson ---");
      console.log(JSON.stringify(lessonDocument.lesson, null, 2));
      console.log("--------------------");
      res.status(200).json({ success: true, lesson: lessonDocument.lesson });
    } else {
      console.log("Lesson not found.");
      res.status(404).json({ success: false, message: "Lesson not found." });
    }
  } catch (error) {
    console.error("Failed to fetch lesson from MongoDB:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch lesson." });
  }
});

app.get("/lessons/:teacherName", async (req, res) => {
  try {
    const { teacherName } = req.params;

    if (!teacherName) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: teacherName",
      });
    }

    console.log(`Fetching lessons for teacher: "${teacherName}"`);

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const teacherDocument = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } } // Only get the units field, exclude _id
    );

    if (teacherDocument && teacherDocument.units) {
      console.log(`Found units for teacher ${teacherName}`);
      res.status(200).json({ success: true, units: teacherDocument.units });
    } else {
      console.log(`No lessons or units found for teacher ${teacherName}.`);
      // Return empty array if no units found, which is not an error.
      res.status(200).json({ success: true, units: [] });
    }
  } catch (error) {
    console.error("Failed to fetch lessons from MongoDB:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch lessons." });
  }
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
