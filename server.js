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

    // --- 3. Emit Socket.IO event to update lesson management modal ---
    io.emit("lessonCreated", {
      teacherName: teacher,
      lessonData: {
        _id: lessonInsertResult.insertedId,
        ...lesson,
      },
      unitData: unit,
    });

    // Also emit a unit update event in case this created a new unit
    io.emit("unitUpdated", {
      teacherName: teacher,
      unitData: unit,
    });

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

app.post("/assign-unit", async (req, res) => {
  try {
    const { teacherName, unitValue, classPeriod } = req.body;

    if (!teacherName || !unitValue || !classPeriod) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields." });
    }

    console.log("--- Assign Unit Request Received ---");
    console.log(`Teacher: ${teacherName}`);
    console.log(`Unit Value: ${unitValue}`);
    console.log(`Class Period: ${classPeriod}`);

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Step 1: Un-assign this period from any other unit for this teacher.
    // This ensures a class period is only assigned to one unit at a time.
    await teachersCollection.updateOne(
      { name: teacherName, "units.assigned_to_period": classPeriod },
      { $unset: { "units.$.assigned_to_period": "" } }
    );

    // Step 2: Assign the period to the selected unit.
    const updateResult = await teachersCollection.updateOne(
      { name: teacherName, "units.value": unitValue },
      { $set: { "units.$.assigned_to_period": classPeriod } }
    );

    if (updateResult.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher or unit not found." });
    }

    // Step 3: Fetch the full unit data that was just assigned.
    // This is more efficient and also verifies the update.
    const teacherDoc = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } } // Only get the units array
    );

    if (!teacherDoc || !teacherDoc.units) {
      return res.status(404).json({
        success: false,
        message: "Could not retrieve teacher's units after assignment.",
      });
    }
    // Find the unit that is now assigned to the class period.
    const assignedUnit = teacherDoc.units.find(
      (u) => u.assigned_to_period === classPeriod
    );

    if (!assignedUnit) {
      return res.status(500).json({
        success: false,
        message: "Failed to verify unit assignment after update.",
      });
    }

    console.log("--- Unit and Teacher for Assignment ---");
    console.log("Teacher:", teacherName);
    console.log("Assigned Unit:", JSON.stringify(assignedUnit, null, 2));

    // Convert classPeriod string (e.g., "01") to a number for querying student profiles.
    const classPeriodAsNumber = parseInt(classPeriod, 10);
    if (isNaN(classPeriodAsNumber)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid class period format." });
    }

    // Find the students to be updated so we can log them.
    const studentsToUpdate = await profilesCollection
      .find(
        { teacher: teacherName, classPeriod: classPeriodAsNumber },
        { projection: { memberName: 1, _id: 0 } } // Project only names for logging
      )
      .toArray();

    console.log("--- Students to be updated ---");
    console.log(studentsToUpdate.map((s) => s.memberName));

    // Step 4: Update all students in that class with the assigned unit.
    const studentUpdateResult = await profilesCollection.updateMany(
      { teacher: teacherName, classPeriod: classPeriodAsNumber },
      { $addToSet: { assignedUnits: assignedUnit } }
    );

    console.log(
      `Assigned unit to ${studentUpdateResult.modifiedCount} students in period ${classPeriod} for teacher ${teacherName}.`
    );

    // --- Emit Socket.IO event to update lesson management modal ---
    io.emit("unitAssigned", {
      teacherName: teacherName,
      unitData: assignedUnit,
      classPeriod: classPeriod,
    });

    res
      .status(200)
      .json({ success: true, message: "Unit assigned successfully." });
  } catch (error) {
    console.error("Failed to assign unit:", error);
    res.status(500).json({ success: false, message: "Failed to assign unit." });
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

    console.log(`Fetching all lessons and units for teacher: "${teacherName}"`);

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Fetch units from the teacher's document
    const teacherDocument = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } } // Only get the units field, exclude _id
    );

    // Fetch all individual lessons from the Lessons collection
    const allLessons = await lessonsCollection
      .find({ teacher: teacherName })
      .project({ lesson: 1, _id: 1 }) // Project lesson object AND the document's _id
      .toArray();

    // The result is an array of objects like [{ _id: ..., lesson: {...} }, ...].
    // We'll map this to a more useful structure for the frontend.
    const flattenedLessons = allLessons.map((item) => ({
      _id: item._id,
      ...item.lesson, // Spread the properties of the nested lesson object
    }));

    const units =
      teacherDocument && teacherDocument.units ? teacherDocument.units : [];

    console.log(`Found ${units.length} units for teacher ${teacherName}.`);
    console.log(
      `Found ${flattenedLessons.length} total lessons for teacher ${teacherName}.`
    );

    res
      .status(200)
      .json({ success: true, units: units, lessons: flattenedLessons });
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
