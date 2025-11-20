require("dotenv").config();

const express = require("express");
const app = express();

const cors = require("cors");

const port = process.env.PORT || 4000;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:4000"];
const mongoUri =
  process.env.MONGODB_URI || "mongodb://localhost:27017/TrinityCapital";

console.log("Configuring CORS with origins:", allowedOrigins);

// Create a CORS middleware with specific options
app.use(
  cors({
    origin: true, // Allow all origins temporarily
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Origin",
      "X-Requested-With",
      "Accept",
    ],
  })
);
app.use(express.json());

// Add error handling middleware for Express parsing errors
app.use((err, req, res, next) => {
  console.error("Error in middleware:", err);
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).send({ success: false, message: "Invalid JSON" });
  }
  next(err);
});

// Handle OPTIONS requests for all routes (CORS preflight)
app.options("*", (req, res) => {
  console.log("Received preflight OPTIONS request");
  console.log("Origin:", req.headers.origin);

  // Set CORS headers
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Origin, X-Requested-With, Accept"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  res.status(200).end();
});

/*****************************************Socket.io***************************************************/

const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: process.env.SOCKET_ORIGIN
      ? process.env.SOCKET_ORIGIN.split(",")
      : ["http://localhost:3000"],
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

  // Handle teacher lesson management events
  socket.on("joinLessonManagement", (teacherName) => {
    try {
      console.log(`Teacher ${teacherName} joined lesson management`);
      socket.join(`lessonManagement-${teacherName}`);
      socket.emit("lessonManagementJoined", {
        success: true,
        teacherName: teacherName,
      });
    } catch (error) {
      console.error("Error joining lesson management:", error);
      socket.emit("error", { message: "Failed to join lesson management" });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // Remove from userSockets map
    for (const [userId, userSocket] of userSockets.entries()) {
      if (userSocket === socket) {
        userSockets.delete(userId);
        break;
      }
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

    // Create lesson object with the MongoDB-generated _id
    const lessonWithId = {
      ...lesson,
      _id: lessonInsertResult.insertedId.toString(), // Convert ObjectId to string for consistency
    };

    // Step 2a: Try to push the lesson into an existing unit's 'lessons' array.
    const updateResult = await teachersCollection.updateOne(
      { name: teacher, "units.value": unit.value },
      { $push: { "units.$.lessons": lessonWithId } }
    );

    // Step 2b: If the unit didn't exist for that teacher, add the new unit to the teacher's 'units' array.
    if (updateResult.matchedCount === 0) {
      // This update handles cases where the 'units' array exists but the specific unit doesn't,
      // or where the 'units' array doesn't exist at all.
      const addUnitResult = await teachersCollection.updateOne(
        { name: teacher },
        { $push: { units: { ...unit, lessons: [lessonWithId] } } }
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

    // --- Fetch updated unit data from database before emitting events ---
    const updatedTeacherDoc = await teachersCollection.findOne(
      { name: teacher },
      { projection: { units: 1, _id: 0 } }
    );

    res
      .status(201)
      .json({ success: true, lessonId: lessonInsertResult.insertedId });
  } catch (error) {
    console.error("Failed to save lesson:", error);
    res.status(500).json({ success: false, message: "Failed to save lesson." });
  }
});

app.post("/update-lesson", async (req, res) => {
  try {
    const { lesson, unit, teacher, lessonId } = req.body;

    console.log("--- Update Lesson Request ---");
    console.log("Teacher:", teacher);
    console.log("Unit:", unit.name, "(" + unit.value + ")");
    console.log("Lesson ID:", lessonId);
    console.log("Lesson Title:", lesson.lesson_title);

    // Import ObjectId for MongoDB operations
    const { ObjectId } = require("mongodb");

    // --- 1. Update the lesson in the "Lessons" collection ---
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    const lessonUpdateResult = await lessonsCollection.updateOne(
      { _id: new ObjectId(lessonId) },
      {
        $set: {
          "lesson.lesson_title": lesson.lesson_title,
          "lesson.lesson_description": lesson.lesson_description,
          "lesson.lesson_blocks": lesson.lesson_blocks,
          "lesson.lesson_conditions": lesson.lesson_conditions,
          updatedAt: new Date(),
        },
      }
    );

    if (lessonUpdateResult.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found in Lessons collection",
      });
    }

    console.log("Lesson updated in 'Lessons' collection");

    // --- 2. Update the lesson in the teacher's "Teachers" collection ---
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Update the lesson in the specific unit's lessons array
    const teacherUpdateResult = await teachersCollection.updateOne(
      {
        name: teacher,
        "units.value": unit.value,
        "units.lessons._id": lessonId,
      },
      {
        $set: {
          "units.$[unit].lessons.$[lesson].lesson_title": lesson.lesson_title,
          "units.$[unit].lessons.$[lesson].lesson_description":
            lesson.lesson_description,
          "units.$[unit].lessons.$[lesson].lesson_blocks": lesson.lesson_blocks,
          "units.$[unit].lessons.$[lesson].lesson_conditions":
            lesson.lesson_conditions,
        },
      },
      {
        arrayFilters: [
          { "unit.value": unit.value },
          { "lesson._id": lessonId },
        ],
      }
    );

    console.log(
      "Teacher lesson update result:",
      teacherUpdateResult.matchedCount > 0 ? "Success" : "Not found"
    );

    // --- 3. Fetch updated unit data ---
    const updatedTeacherDoc = await teachersCollection.findOne(
      { name: teacher },
      { projection: { units: 1, _id: 0 } }
    );

    let updatedUnit = null;
    if (updatedTeacherDoc && updatedTeacherDoc.units) {
      updatedUnit = updatedTeacherDoc.units.find((u) => u.value === unit.value);
    }

    const unitToEmit = updatedUnit || unit;

    // --- 4. Emit Socket.IO events ---
    io.emit("lessonUpdated", {
      teacherName: teacher,
      lessonData: {
        _id: lessonId,
        ...lesson,
      },
      unitData: unitToEmit,
    });

    io.emit("lessonManagementRefresh", {
      teacherName: teacher,
      action: "lessonUpdated",
      lessonData: {
        _id: lessonId,
        ...lesson,
      },
      unitData: unitToEmit,
    });

    console.log("--- Socket events emitted for lesson update ---");
    console.log(`Teacher: ${teacher}`);
    console.log(`Unit: ${unitToEmit.name} (${unitToEmit.value})`);
    console.log(`Updated Lesson: ${lesson.lesson_title}`);

    res.status(200).json({
      success: true,
      message: "Lesson updated successfully",
      lessonId: lessonId,
    });
  } catch (error) {
    console.error("Failed to update lesson:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update lesson: " + error.message,
    });
  }
});

// Debug endpoint to check lesson data and history
app.get("/debug-lesson/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;
    const { ObjectId } = require("mongodb");

    console.log("--- Debug Lesson Request ---");
    console.log("Lesson ID:", lessonId);

    // Get lesson from both collections
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Find in Lessons collection
    const lessonInLessons = await lessonsCollection.findOne({
      _id: new ObjectId(lessonId),
    });

    // Find in Teachers collection
    const teacherWithLesson = await teachersCollection.findOne({
      "units.lessons._id": lessonId,
    });

    let lessonInTeachers = null;
    if (teacherWithLesson) {
      for (const unit of teacherWithLesson.units) {
        const lesson = unit.lessons.find((l) => l._id === lessonId);
        if (lesson) {
          lessonInTeachers = {
            ...lesson,
            unitName: unit.name,
            unitValue: unit.value,
          };
          break;
        }
      }
    }

    res.json({
      success: true,
      lessonInLessons: lessonInLessons,
      lessonInTeachers: lessonInTeachers,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Debug lesson error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to debug lesson: " + error.message,
    });
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

    console.log("--- Assign Unit Request Received (ObjectID-based) ---");
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

    // Step 3: Fetch the unit that was just assigned.
    const teacherDoc = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } }
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

    console.log("--- Unit Selected for Assignment ---");
    console.log("Teacher:", teacherName);
    console.log("Unit Name:", assignedUnit.name);
    console.log("Unit Value:", assignedUnit.value);
    console.log(
      "Lesson References:",
      assignedUnit.lessons ? assignedUnit.lessons.length : 0
    );

    // DEBUG: Check the lesson structure
    if (assignedUnit.lessons && assignedUnit.lessons.length > 0) {
      console.log("--- DEBUG: Lesson Structure Analysis ---");
      assignedUnit.lessons.forEach((lesson, index) => {
        console.log(`Lesson ${index + 1}:`, {
          title: lesson.lesson_title || "No title",
          hasId: !!lesson._id,
          id: lesson._id,
          allKeys: Object.keys(lesson),
        });
      });
    }

    // NEW APPROACH: Create assignment with ObjectID references only
    // Handle lessons that might not have _id properties (legacy data)
    let lessonIds = [];
    if (assignedUnit.lessons && assignedUnit.lessons.length > 0) {
      console.log("--- Processing lesson IDs ---");
      for (const lesson of assignedUnit.lessons) {
        if (lesson._id) {
          lessonIds.push(lesson._id);
          console.log(
            `✓ Lesson "${lesson.lesson_title}" has ID: ${lesson._id}`
          );
        } else {
          console.log(
            `⚠ Lesson "${lesson.lesson_title}" missing _id - will try to find in Lessons collection`
          );

          // Try to find this lesson in the Lessons collection by matching content
          try {
            const lessonsCollection = client
              .db("TrinityCapital")
              .collection("Lessons");
            const foundLesson = await lessonsCollection.findOne({
              teacher: teacherName,
              "unit.value": assignedUnit.value,
              "lesson.lesson_title": lesson.lesson_title,
            });

            if (foundLesson) {
              console.log(
                `✓ Found matching lesson in Lessons collection with ID: ${foundLesson._id}`
              );
              lessonIds.push(foundLesson._id.toString());

              // Update the lesson in the teacher's units to include the _id for future use
              await teachersCollection.updateOne(
                {
                  name: teacherName,
                  "units.value": assignedUnit.value,
                  "units.lessons.lesson_title": lesson.lesson_title,
                },
                {
                  $set: {
                    "units.$[unit].lessons.$[lesson]._id":
                      foundLesson._id.toString(),
                  },
                },
                {
                  arrayFilters: [
                    { "unit.value": assignedUnit.value },
                    { "lesson.lesson_title": lesson.lesson_title },
                  ],
                }
              );
              console.log(
                `✓ Updated teacher's unit with missing _id for lesson: ${lesson.lesson_title}`
              );
            } else {
              console.log(
                `✗ Could not find lesson "${lesson.lesson_title}" in Lessons collection`
              );
            }
          } catch (error) {
            console.error(
              `Error looking up lesson "${lesson.lesson_title}":`,
              error
            );
          }
        }
      }
    }

    const unitAssignment = {
      unitId: assignedUnit._id || assignedUnit.value, // Use unit ObjectID if available, fallback to value
      unitName: assignedUnit.name,
      unitValue: assignedUnit.value,
      teacherName: teacherName,
      lessonIds: lessonIds,
      assignedAt: new Date(),
      classPeriod: classPeriod,
    };

    console.log("--- ObjectID-based Unit Assignment ---");
    console.log(
      "Unit Assignment Object:",
      JSON.stringify(unitAssignment, null, 2)
    );
    console.log(
      `Will assign ${unitAssignment.lessonIds.length} lesson ObjectIDs to students`
    );

    // DEBUG: Show what happened during lessonIds creation
    if (assignedUnit.lessons) {
      console.log("--- DEBUG: Lesson ID Mapping Results ---");
      const mappingResults = assignedUnit.lessons.map((lesson, index) => {
        const hasId = !!lesson._id;
        const id = lesson._id;
        return {
          index: index + 1,
          title: lesson.lesson_title || "No title",
          hasId: hasId,
          id: id,
          includedInFinal: hasId && id,
        };
      });
      console.log("Mapping results:", mappingResults);
      console.log("Final lessonIds:", unitAssignment.lessonIds);
    }

    // Convert classPeriod string to number for querying student profiles
    const classPeriodAsNumber = parseInt(classPeriod, 10);
    if (isNaN(classPeriodAsNumber)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid class period format." });
    }

    // Find students to be updated
    const studentsToUpdate = await profilesCollection
      .find(
        { teacher: teacherName, classPeriod: classPeriodAsNumber },
        { projection: { memberName: 1, _id: 0 } }
      )
      .toArray();

    console.log("--- Students to be updated ---");
    console.log(
      `Found ${studentsToUpdate.length} students:`,
      studentsToUpdate.map((s) => s.memberName)
    );

    // Step 4: Update students with ObjectID-based assignment (remove duplicates)
    const studentUpdateResult = await profilesCollection.updateMany(
      { teacher: teacherName, classPeriod: classPeriodAsNumber },
      {
        $addToSet: {
          assignedUnitIds: unitAssignment, // Use addToSet to prevent duplicates
        },
      }
    );

    console.log(
      `✅ ASSIGNED UNIT REFERENCES to ${studentUpdateResult.modifiedCount} students`
    );
    console.log(
      `Each student now has ObjectID references for unit: ${assignedUnit.name}`
    );
    console.log(
      `Lesson ObjectIDs assigned: ${unitAssignment.lessonIds.join(", ")}`
    );

    // --- Emit Socket.IO events ---
    io.emit("unitAssigned", {
      teacherName: teacherName,
      unitData: assignedUnit,
      classPeriod: classPeriod,
      assignmentType: "objectId-based",
    });

    io.emit("lessonManagementRefresh", {
      teacherName: teacherName,
      action: "unitAssigned",
      unitData: assignedUnit,
      classPeriod: classPeriod,
    });

    io.to(`lessonManagement-${teacherName}`).emit("unitAssignmentUpdated", {
      teacherName: teacherName,
      unitData: assignedUnit,
      classPeriod: classPeriod,
      timestamp: new Date().toISOString(),
    });

    // NEW: Emit specific event for students to refresh their lessons
    // This will be picked up by the student frontend to reload lessons
    studentsToUpdate.forEach((student) => {
      io.emit("unitAssignedToStudent", {
        studentId: student.memberName,
        studentName: student.memberName,
        unitId: assignedUnit._id || assignedUnit.value,
        unitName: assignedUnit.name,
        unitValue: assignedUnit.value,
        assignedBy: teacherName,
        unitAssignment: unitAssignment,
        assignmentType: "objectId-based",
        classPeriod: classPeriod,
        timestamp: new Date().toISOString(),
      });
    });

    console.log(
      `✅ Emitted unitAssignedToStudent events for ${studentsToUpdate.length} students`
    );
    studentsToUpdate.forEach((student) => {
      console.log(`  - Notified student: ${student.memberName}`);
    });

    res.status(200).json({
      success: true,
      message: "Unit assigned successfully using ObjectID references.",
      assignmentDetails: {
        unitName: assignedUnit.name,
        studentsUpdated: studentUpdateResult.modifiedCount,
        lessonIdsAssigned: unitAssignment.lessonIds.length,
        assignmentType: "objectId-based",
      },
    });
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

    // Define the master teacher whose content becomes default for all users
    const MASTER_TEACHER = "admin@trinity-capital.net";

    // Fetch units from the teacher's document
    const teacherDocument = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } } // Only get the units field, exclude _id
    );

    // Fetch master teacher's content as defaults
    let masterUnits = [];
    let masterLessons = [];

    if (teacherName !== MASTER_TEACHER) {
      console.log(`Fetching master content from ${MASTER_TEACHER}...`);

      // Get master teacher's units
      const masterTeacherDocument = await teachersCollection.findOne(
        { name: MASTER_TEACHER },
        { projection: { units: 1, _id: 0 } }
      );

      if (masterTeacherDocument && masterTeacherDocument.units) {
        masterUnits = masterTeacherDocument.units;
        console.log(
          `Found ${masterUnits.length} master units from ${MASTER_TEACHER}.`
        );
      }

      // Get master teacher's lessons - FETCH COMPLETE LESSON OBJECTS
      const masterLessonsData = await lessonsCollection
        .find({ teacher: MASTER_TEACHER })
        .toArray(); // Get complete lesson documents

      masterLessons = masterLessonsData.map((item) => ({
        _id: item._id,
        teacher: item.teacher,
        unit: item.unit,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...item.lesson, // This includes lesson_blocks, lesson_conditions, etc.
        isMasterContent: true, // Flag to identify master content
      }));

      console.log(
        `Found ${masterLessons.length} master lessons from ${MASTER_TEACHER}.`
      );
    }

    // Fetch teacher's own lessons - FETCH COMPLETE LESSON OBJECTS
    const teacherLessons = await lessonsCollection
      .find({ teacher: teacherName })
      .toArray(); // Get complete lesson documents

    const teacherFlattenedLessons = teacherLessons.map((item) => ({
      _id: item._id,
      teacher: item.teacher,
      unit: item.unit,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...item.lesson, // This includes lesson_blocks, lesson_conditions, etc.
      isMasterContent: false, // Flag teacher's own content
    }));

    // For lesson management modal: prioritize teacher's own units, fallback to master units
    let combinedUnits = [];
    const teacherUnits =
      teacherDocument && teacherDocument.units ? teacherDocument.units : [];

    if (teacherName === MASTER_TEACHER) {
      // For master teacher, just return their own content
      combinedUnits = teacherUnits;
    } else {
      // For other teachers: merge custom units with remaining default units
      if (teacherUnits.length > 0) {
        // Teacher has their own units - merge with remaining default units
        // Start with teacher's custom units
        combinedUnits = [...teacherUnits];

        // Add default units that haven't been replaced by custom units
        const customUnitValues = new Set(
          teacherUnits.map((unit) => unit.value)
        );
        const remainingDefaultUnits = masterUnits
          .filter((unit) => !customUnitValues.has(unit.value))
          .map((unit) => ({
            ...unit,
            isDefaultUnit: true, // Flag to indicate this is a default unit
          }));

        combinedUnits.push(...remainingDefaultUnits);

        console.log(
          `Using teacher's ${teacherUnits.length} custom units + ${remainingDefaultUnits.length} remaining default units`
        );
      } else {
        // Teacher has no units yet - show master units as defaults
        combinedUnits = masterUnits.map((unit) => ({
          ...unit,
          isDefaultUnit: true, // Flag to indicate this is a default unit
        }));
        console.log(
          `Teacher has no units yet, showing ${masterUnits.length} default units from ${MASTER_TEACHER}`
        );
      }
    }

    // For lesson management modal: prioritize teacher's own lessons, include master lessons appropriately
    let combinedLessons = [];

    if (teacherName === MASTER_TEACHER) {
      // For master teacher, show only their own lessons
      combinedLessons = teacherFlattenedLessons;
    } else {
      if (teacherUnits.length > 0) {
        // Teacher has their own units - show their own lessons + relevant master lessons for selection
        combinedLessons = [
          ...teacherFlattenedLessons, // Teacher's own lessons first
          ...masterLessons.filter(
            (masterLesson) =>
              !teacherFlattenedLessons.some(
                (teacherLesson) =>
                  teacherLesson.lesson_title === masterLesson.lesson_title
              )
          ), // Add master lessons that don't conflict with teacher's lessons
        ];
      } else {
        // Teacher has no units yet - show master lessons as defaults for lesson management
        combinedLessons = masterLessons.map((lesson) => ({
          ...lesson,
          isDefaultLesson: true, // Flag to indicate this is a default lesson
        }));
        console.log(
          `Teacher has no lessons yet, showing ${masterLessons.length} default lessons from ${MASTER_TEACHER}`
        );
      }
    }

    // CRITICAL FIX: Populate full lesson objects with lesson_blocks into units
    console.log("🔧 POPULATING FULL LESSON OBJECTS INTO UNITS...");

    // Collect all unique lesson IDs that need to be populated
    const allLessonIds = new Set();
    combinedUnits.forEach((unit) => {
      if (unit.lessons) {
        unit.lessons.forEach((lesson) => {
          if (lesson._id) {
            allLessonIds.add(lesson._id.toString());
          }
        });
      }
    });

    console.log(
      `Found ${allLessonIds.size} unique lesson IDs to populate across all units`
    );

    // Fetch all required lessons in bulk
    const { ObjectId } = require("mongodb");
    const lessonIdsArray = Array.from(allLessonIds).map(
      (id) => new ObjectId(id)
    );

    const fullLessonObjects = await lessonsCollection
      .find({ _id: { $in: lessonIdsArray } })
      .toArray();

    console.log(
      `Fetched ${fullLessonObjects.length} full lesson objects from database`
    );

    // Create a lookup map for quick access
    const lessonLookup = {};
    fullLessonObjects.forEach((lessonDoc) => {
      lessonLookup[lessonDoc._id.toString()] = {
        _id: lessonDoc._id,
        ...lessonDoc.lesson, // This includes lesson_blocks, lesson_conditions, etc.
      };
    });

    // Replace lesson references with full lesson objects in all units
    combinedUnits.forEach((unit) => {
      if (unit.lessons) {
        unit.lessons = unit.lessons.map((lessonRef) => {
          const lessonId = lessonRef._id ? lessonRef._id.toString() : null;
          if (lessonId && lessonLookup[lessonId]) {
            console.log(
              `✅ Populated full lesson object for: ${lessonLookup[lessonId].lesson_title}`
            );
            return lessonLookup[lessonId];
          } else {
            console.log(
              `⚠️ Could not find full lesson object for lesson: ${lessonRef.lesson_title || "Unknown"}`
            );
            return lessonRef; // Return reference as fallback
          }
        });
      }
    });

    console.log("✅ COMPLETED LESSON POPULATION INTO UNITS");

    // DEBUG: Log the complete structure of units being returned
    console.log("🚨 DEBUGGING COMPLETE UNIT STRUCTURE:");
    combinedUnits.forEach((unit, unitIndex) => {
      console.log(`Unit ${unitIndex + 1}: ${unit.name} (${unit.value})`);
      console.log(
        `  - Lessons count: ${unit.lessons ? unit.lessons.length : 0}`
      );
      if (unit.lessons && unit.lessons.length > 0) {
        unit.lessons.forEach((lesson, lessonIndex) => {
          console.log(
            `    Lesson ${lessonIndex + 1}: ${lesson.lesson_title || "NO TITLE"}`
          );
          console.log(`      - Has lesson_blocks: ${!!lesson.lesson_blocks}`);
          console.log(
            `      - lesson_blocks count: ${lesson.lesson_blocks ? lesson.lesson_blocks.length : 0}`
          );
          console.log(
            `      - Has lesson_conditions: ${!!lesson.lesson_conditions}`
          );
          console.log(
            `      - lesson_conditions count: ${lesson.lesson_conditions ? lesson.lesson_conditions.length : 0}`
          );
          console.log(
            `      - Has intro_text_blocks: ${!!lesson.intro_text_blocks}`
          );
          console.log(
            `      - intro_text_blocks count: ${lesson.intro_text_blocks ? lesson.intro_text_blocks.length : 0}`
          );
          console.log(
            `      - All lesson keys: ${Object.keys(lesson).join(", ")}`
          );

          // Log the first few characters of the complete lesson object
          const lessonStr = JSON.stringify(lesson);
          console.log(
            `      - Complete lesson (first 200 chars): ${lessonStr.substring(0, 200)}...`
          );
        });
      }
    });

    console.log(`Final result for ${teacherName}:`);
    if (teacherName === MASTER_TEACHER) {
      console.log(
        `- ${combinedUnits.length} own units, ${combinedLessons.length} own lessons (master teacher)`
      );
    } else if (teacherUnits.length > 0) {
      const customUnits = combinedUnits.filter((u) => !u.isDefaultUnit).length;
      const defaultUnits = combinedUnits.filter((u) => u.isDefaultUnit).length;
      console.log(
        `- ${combinedUnits.length} total units (${customUnits} custom + ${defaultUnits} default), ${combinedLessons.length} total lessons (${teacherFlattenedLessons.length} own + ${masterLessons.length} master available)`
      );
    } else {
      console.log(
        `- ${combinedUnits.length} default units, ${combinedLessons.length} default lessons (from ${MASTER_TEACHER})`
      );
    }

    res.status(200).json({
      success: true,
      units: combinedUnits,
      lessons: combinedLessons,
      masterTeacher: MASTER_TEACHER,
      isUsingMasterDefaults:
        teacherName !== MASTER_TEACHER && teacherUnits.length === 0,
      hasOwnContent: teacherUnits.length > 0,
      contentType:
        teacherName === MASTER_TEACHER
          ? "master"
          : teacherUnits.length > 0
            ? "own"
            : "default",
    });
  } catch (error) {
    console.error("Failed to fetch lessons from MongoDB:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch lessons." });
  }
});

app.post("/saveUnitChanges", async (req, res) => {
  try {
    const { teacherName, unitData } = req.body;

    if (!teacherName || !unitData) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: teacherName, unitData",
      });
    }

    console.log(`Saving unit changes for teacher: "${teacherName}"`);
    console.log("Unit data:", JSON.stringify(unitData, null, 2));

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Define the master teacher
    const MASTER_TEACHER = "admin@trinity-capital.net";

    // Check if this is a default unit being edited by a non-master teacher
    if (unitData.isDefaultUnit && teacherName !== MASTER_TEACHER) {
      console.log(
        `Teacher ${teacherName} attempted to edit default unit. Blocking with guidance message.`
      );
      return res.status(403).json({
        success: false,
        message:
          "You cannot modify default units. Please create your own unit and lessons instead.",
        isDefaultUnitError: true,
      });
    }

    // If teacher is trying to save a default unit and they ARE the master teacher,
    // update the master teacher's document instead
    if (unitData.isDefaultUnit && teacherName === MASTER_TEACHER) {
      console.log(
        `Master teacher editing default unit - updating master document`
      );
      // Remove the isDefaultUnit flag before saving
      const cleanUnitData = { ...unitData };
      delete cleanUnitData.isDefaultUnit;

      const updateResult = await teachersCollection.updateOne(
        { name: MASTER_TEACHER, "units.value": cleanUnitData.value },
        { $set: { "units.$": cleanUnitData } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Master teacher unit not found.",
        });
      }
    } else {
      // Normal case: teacher editing their own unit
      const updateResult = await teachersCollection.updateOne(
        { name: teacherName, "units.value": unitData.value },
        { $set: { "units.$": unitData } }
      );

      if (updateResult.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Teacher or unit not found.",
        });
      }
    }

    console.log(`Unit changes saved successfully for teacher ${teacherName}.`);

    // Emit Socket.IO event to update lesson management modal
    io.emit("unitUpdated", {
      teacherName: teacherName,
      unitData: unitData,
    });

    // Emit event specifically for lesson management modal refresh
    io.emit("lessonManagementRefresh", {
      teacherName: teacherName,
      action: "unitModified",
      unitData: unitData,
    });

    // Emit to teacher-specific lesson management room
    io.to(`lessonManagement-${teacherName}`).emit("unitChangesApplied", {
      teacherName: teacherName,
      unitData: unitData,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: "Unit changes saved successfully.",
    });
  } catch (error) {
    console.error("Failed to save unit changes:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save unit changes.",
    });
  }
});

app.post("/create-custom-unit", async (req, res) => {
  try {
    const { teacherName, unitData } = req.body;

    if (!teacherName || !unitData) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: teacherName, unitData",
      });
    }

    console.log(`Creating custom unit for teacher: "${teacherName}"`);
    console.log("Unit data:", JSON.stringify(unitData, null, 2));

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Define the master teacher
    const MASTER_TEACHER = "admin@trinity-capital.net";

    // Prepare the unit data
    const newUnit = {
      value: unitData.value,
      name: unitData.name,
      lessons: [],
      isDefaultUnit: false, // Mark as custom unit
    };

    // Check if teacher already has this unit
    const teacherDocument = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } }
    );

    if (teacherDocument && teacherDocument.units) {
      const existingUnitIndex = teacherDocument.units.findIndex(
        (unit) => unit.value === unitData.value
      );

      if (existingUnitIndex !== -1) {
        // Replace existing unit (could be default or custom)
        const updateResult = await teachersCollection.updateOne(
          { name: teacherName, "units.value": unitData.value },
          { $set: { "units.$": newUnit } }
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Failed to update existing unit.",
          });
        }

        console.log(
          `Replaced existing unit ${unitData.value} for teacher ${teacherName}`
        );
      } else {
        // Add new unit
        const addResult = await teachersCollection.updateOne(
          { name: teacherName },
          { $push: { units: newUnit } }
        );

        if (addResult.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Teacher not found.",
          });
        }

        console.log(
          `Added new unit ${unitData.value} for teacher ${teacherName}`
        );
      }
    } else {
      // Teacher has no units array yet, create it with this unit
      const addResult = await teachersCollection.updateOne(
        { name: teacherName },
        { $set: { units: [newUnit] } }
      );

      if (addResult.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Teacher not found.",
        });
      }

      console.log(
        `Created first unit ${unitData.value} for teacher ${teacherName}`
      );
    }

    // Emit Socket.IO events
    io.emit("unitCreated", {
      teacherName: teacherName,
      unitData: newUnit,
    });

    io.emit("lessonManagementRefresh", {
      teacherName: teacherName,
      action: "unitCreated",
      unitData: newUnit,
    });

    io.to(`lessonManagement-${teacherName}`).emit("customUnitCreated", {
      teacherName: teacherName,
      unitData: newUnit,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: "Custom unit created successfully.",
      unitData: newUnit,
    });
  } catch (error) {
    console.error("Failed to create custom unit:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create custom unit.",
    });
  }
});

app.post("/copy-default-unit", async (req, res) => {
  try {
    const { teacherName, unitValue } = req.body;

    if (!teacherName || !unitValue) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: teacherName, unitValue",
      });
    }

    // Define the master teacher
    const MASTER_TEACHER = "admin@trinity-capital.net";

    if (teacherName === MASTER_TEACHER) {
      return res.status(400).json({
        success: false,
        message: "Master teacher cannot copy default units.",
      });
    }

    console.log(
      `Copying default unit "${unitValue}" for teacher: "${teacherName}"`
    );

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Get the master teacher's unit
    const masterTeacherDocument = await teachersCollection.findOne(
      { name: MASTER_TEACHER },
      { projection: { units: 1, _id: 0 } }
    );

    if (!masterTeacherDocument || !masterTeacherDocument.units) {
      return res.status(404).json({
        success: false,
        message: "Master teacher content not found.",
      });
    }

    const masterUnit = masterTeacherDocument.units.find(
      (unit) => unit.value === unitValue
    );

    if (!masterUnit) {
      return res.status(404).json({
        success: false,
        message: "Default unit not found.",
      });
    }

    // Get master teacher's lessons for this unit
    const masterLessonsData = await lessonsCollection
      .find({
        teacher: MASTER_TEACHER,
        "unit.value": unitValue,
      })
      .project({ lesson: 1, unit: 1, _id: 0 })
      .toArray();

    // Create a copy of the unit for the teacher
    const newUnit = {
      ...masterUnit,
      // Remove any master-specific flags
      isDefaultUnit: undefined,
      assigned_to_period: undefined, // Don't copy period assignments
    };

    // Clean the unit data
    delete newUnit.isDefaultUnit;
    delete newUnit.assigned_to_period;

    // Check if teacher already has this unit
    const teacherDocument = await teachersCollection.findOne({
      name: teacherName,
      "units.value": unitValue,
    });

    if (teacherDocument) {
      return res.status(409).json({
        success: false,
        message:
          "You already have a unit with this identifier. Please modify your existing unit.",
      });
    }

    // Add the unit to the teacher's document
    await teachersCollection.updateOne(
      { name: teacherName },
      { $push: { units: newUnit } },
      { upsert: true }
    );

    // Copy all lessons from the master teacher to the new teacher
    const copiedLessons = [];
    for (const masterLessonDoc of masterLessonsData) {
      const newLessonDocument = {
        teacher: teacherName,
        unit: { ...masterLessonDoc.unit },
        lesson: { ...masterLessonDoc.lesson },
        createdAt: new Date(),
        copiedFromMaster: true,
      };

      const lessonInsertResult =
        await lessonsCollection.insertOne(newLessonDocument);
      copiedLessons.push({
        _id: lessonInsertResult.insertedId,
        ...newLessonDocument.lesson,
      });
    }

    // Update the unit with the new lesson references
    if (copiedLessons.length > 0) {
      const lessonReferences = copiedLessons.map((lesson) => ({
        _id: lesson._id,
        lesson_title: lesson.lesson_title,
        lesson_type: lesson.lesson_type,
      }));

      await teachersCollection.updateOne(
        { name: teacherName, "units.value": unitValue },
        { $set: { "units.$.lessons": lessonReferences } }
      );
    }

    console.log(
      `Successfully copied unit "${masterUnit.name}" with ${copiedLessons.length} lessons to teacher ${teacherName}`
    );

    res.status(200).json({
      success: true,
      message: `Unit "${masterUnit.name}" copied successfully with ${copiedLessons.length} lessons. You can now modify it as needed.`,
      copiedUnit: newUnit,
      copiedLessonsCount: copiedLessons.length,
    });
  } catch (error) {
    console.error("Failed to copy default unit:", error);
    res.status(500).json({
      success: false,
      message: "Failed to copy default unit.",
    });
  }
});

app.post("/refresh-lesson-management", async (req, res) => {
  try {
    const { teacherName } = req.body;

    if (!teacherName) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: teacherName",
      });
    }

    console.log(`Manual refresh requested for teacher: ${teacherName}`);

    // Fetch current data for the teacher
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Get updated units
    const teacherDocument = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } }
    );

    // Get all lessons
    const allLessons = await lessonsCollection
      .find({ teacher: teacherName })
      .project({ lesson: 1, _id: 1 })
      .toArray();

    const flattenedLessons = allLessons.map((item) => ({
      _id: item._id,
      ...item.lesson,
    }));

    const units =
      teacherDocument && teacherDocument.units ? teacherDocument.units : [];

    console.log(
      `Refreshing data: ${units.length} units, ${flattenedLessons.length} lessons`
    );

    // Emit comprehensive refresh event
    io.emit("lessonManagementCompleteRefresh", {
      teacherName: teacherName,
      units: units,
      lessons: flattenedLessons,
      timestamp: new Date().toISOString(),
    });

    // Also emit to teacher-specific room
    io.to(`lessonManagement-${teacherName}`).emit(
      "lessonManagementCompleteRefresh",
      {
        teacherName: teacherName,
        units: units,
        lessons: flattenedLessons,
        timestamp: new Date().toISOString(),
      }
    );

    res.status(200).json({
      success: true,
      message: "Lesson management refreshed successfully.",
      data: { units, lessons: flattenedLessons },
    });
  } catch (error) {
    console.error("Failed to refresh lesson management:", error);
    res.status(500).json({
      success: false,
      message: "Failed to refresh lesson management.",
    });
  }
});

app.post("/lesson-management-update", async (req, res) => {
  try {
    const { teacherName, action, data } = req.body;

    if (!teacherName || !action) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: teacherName, action",
      });
    }

    console.log(
      `Lesson management update for teacher: ${teacherName}, action: ${action}`
    );

    // Emit specific event for lesson management modal updates
    io.emit("lessonManagementUpdate", {
      teacherName: teacherName,
      action: action,
      data: data,
      timestamp: new Date().toISOString(),
    });

    // Also emit to specific teacher if they have a socket connection
    const teacherSocket = userSockets.get(teacherName);
    if (teacherSocket) {
      teacherSocket.emit("lessonManagementUpdate", {
        teacherName: teacherName,
        action: action,
        data: data,
        timestamp: new Date().toISOString(),
      });
    }

    res.status(200).json({
      success: true,
      message: "Lesson management update sent successfully.",
    });
  } catch (error) {
    console.error("Failed to send lesson management update:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send lesson management update.",
    });
  }
});

app.post("/data", (req, res) => {
  console.log("Received data:", req.body);
  res.status(200).json({ success: true, message: "Data received and logged." });
});

app.post("/api/sdsm/session", async (req, res) => {
  try {
    const { studentName, activeLessons } = req.body;
    if (!studentName || !activeLessons) {
      return res.status(400).json({
        success: false,
        message: "Missing studentName or activeLessons in request.",
      });
    }

    console.log("Received student session data for:", studentName);
    console.log("Session Data:", req.body);

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Use $addToSet with $each to add new lessons to the activeLessons array
    // without creating duplicates. This will also create the "Lesson Data" object
    // and the "activeLessons" array if they don't exist.
    const updateResult = await profilesCollection.updateOne(
      { memberName: studentName },
      {
        $addToSet: {
          "Lesson Data.activeLessons": { $each: activeLessons },
        },
      }
    );

    if (updateResult.matchedCount === 0) {
      console.log(`Student profile not found for: ${studentName}`);
      return res
        .status(404)
        .json({ success: false, message: "Student profile not found." });
    }

    if (updateResult.modifiedCount > 0) {
      console.log(
        `Active lessons updated for ${studentName}.`,
        updateResult.modifiedCount
      );
    } else {
      console.log(`No new active lessons to add for ${studentName}.`);
    }

    res.status(200).json({ success: true, message: "Active lessons updated." });
  } catch (error) {
    console.error("Error processing SDSM session data:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to store session data." });
  }
});

// New endpoint for students to get lessons for their class period
// This always uses admin@trinity-capital.net's content as the default
app.get("/student-lessons/:classPeriod", async (req, res) => {
  try {
    const { classPeriod } = req.params;

    if (!classPeriod) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: classPeriod",
      });
    }

    console.log(`Fetching lessons for class period: ${classPeriod}`);

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Always use admin@trinity-capital.net as the master teacher for student content
    const MASTER_TEACHER = "admin@trinity-capital.net";

    // Get master teacher's units and find which unit is assigned to this class period
    const masterTeacherDocument = await teachersCollection.findOne(
      { name: MASTER_TEACHER },
      { projection: { units: 1, _id: 0 } }
    );

    if (!masterTeacherDocument || !masterTeacherDocument.units) {
      console.log(`No units found for master teacher: ${MASTER_TEACHER}`);
      return res.status(404).json({
        success: false,
        message:
          "No default lessons available. Master teacher content not found.",
      });
    }

    // Find the unit assigned to this class period
    const assignedUnit = masterTeacherDocument.units.find(
      (unit) => unit.assigned_to_period === classPeriod
    );

    if (!assignedUnit) {
      console.log(`No unit assigned to class period: ${classPeriod}`);
      return res.status(404).json({
        success: false,
        message: `No lessons assigned to class period ${classPeriod}.`,
        availableUnits: masterTeacherDocument.units.map((unit) => ({
          name: unit.name,
          value: unit.value,
          assignedPeriod: unit.assigned_to_period || "Not assigned",
        })),
      });
    }

    // Get all lessons from the master teacher for this unit
    const unitLessons = assignedUnit.lessons || [];

    // Get full lesson details from the Lessons collection
    const lessonIds = unitLessons
      .map((lesson) => lesson._id)
      .filter((id) => id);
    const fullLessons = [];

    if (lessonIds.length > 0) {
      const { ObjectId } = require("mongodb");
      const lessonsFromDb = await lessonsCollection
        .find({
          teacher: MASTER_TEACHER,
          _id: { $in: lessonIds.map((id) => new ObjectId(id)) },
        })
        .project({ lesson: 1, _id: 1 })
        .toArray();

      lessonsFromDb.forEach((item) => {
        fullLessons.push({
          _id: item._id,
          ...item.lesson,
          isMasterContent: true,
        });
      });
    }

    // Also include lessons directly embedded in the unit
    unitLessons.forEach((lesson) => {
      if (!lesson._id) {
        // This is an embedded lesson, add it directly
        fullLessons.push({
          ...lesson,
          isMasterContent: true,
        });
      }
    });

    console.log(
      `Found unit "${assignedUnit.name}" with ${fullLessons.length} lessons for period ${classPeriod}`
    );

    res.status(200).json({
      success: true,
      unit: {
        name: assignedUnit.name,
        value: assignedUnit.value,
        classPeriod: classPeriod,
      },
      lessons: fullLessons,
      masterTeacher: MASTER_TEACHER,
      message: `Lessons for class period ${classPeriod} from ${MASTER_TEACHER}`,
    });
  } catch (error) {
    console.error("Failed to fetch student lessons:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lessons for students.",
    });
  }
});

// Alternative endpoint for getting master teacher content regardless of class period
app.get("/master-lessons", async (req, res) => {
  try {
    console.log("Fetching all master teacher content for global access");

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Always use admin@trinity-capital.net as the master teacher
    const MASTER_TEACHER = "admin@trinity-capital.net";

    // Get master teacher's units
    const masterTeacherDocument = await teachersCollection.findOne(
      { name: MASTER_TEACHER },
      { projection: { units: 1, _id: 0 } }
    );

    // Get all master teacher's lessons
    const masterLessonsData = await lessonsCollection
      .find({ teacher: MASTER_TEACHER })
      .project({ lesson: 1, _id: 1 })
      .toArray();

    const masterLessons = masterLessonsData.map((item) => ({
      _id: item._id,
      ...item.lesson,
      isMasterContent: true,
    }));

    const masterUnits =
      masterTeacherDocument && masterTeacherDocument.units
        ? masterTeacherDocument.units
        : [];

    console.log(
      `Returning ${masterUnits.length} units and ${masterLessons.length} lessons from master teacher`
    );

    res.status(200).json({
      success: true,
      units: masterUnits,
      lessons: masterLessons,
      masterTeacher: MASTER_TEACHER,
      message: `All content from master teacher ${MASTER_TEACHER}`,
    });
  } catch (error) {
    console.error("Failed to fetch master lessons:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch master teacher content.",
    });
  }
});

// NEW: Get full lesson content by ObjectIDs for students
app.post("/get-lessons-by-ids", async (req, res) => {
  // Set CORS headers explicitly for this endpoint
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Origin, X-Requested-With, Accept"
  );
  res.header("Access-Control-Allow-Credentials", "true");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  try {
    // SUPER LOUD DEBUG - ALWAYS VISIBLE
    console.log("\n\n");
    console.log(
      "*************************************************************"
    );
    console.log(
      "************ LESSON SERVER: GET-LESSONS-BY-IDS **************"
    );
    console.log(
      "*************************************************************"
    );
    console.log("TIME:", new Date().toISOString());
    console.log("REQUEST RECEIVED FROM CLIENT");
    console.log("REQUEST HEADERS:", JSON.stringify(req.headers, null, 2));
    console.log("REQUEST BODY:", JSON.stringify(req.body, null, 2));

    const { lessonIds, studentName, studentProfile } = req.body;

    if (!lessonIds || !Array.isArray(lessonIds) || lessonIds.length === 0) {
      console.log("ERROR: Missing or invalid lessonIds array");
      console.log("REQUEST BODY STRUCTURE:", Object.keys(req.body));
      console.log("LESSON IDS TYPE:", typeof lessonIds);
      console.log("LESSON IDS VALUE:", lessonIds);
      console.log(
        "*************************************************************\n\n"
      );
      return res.status(400).json({
        success: false,
        message: "Missing or invalid lessonIds array",
      });
    }

    console.log("--- Get Lessons By ObjectIDs Request ---");
    console.log(`[get-lessons-by-ids] Student: ${studentName || "Unknown"}`);
    if (studentProfile) {
      console.log(
        "[get-lessons-by-ids] Student profile:",
        JSON.stringify(studentProfile, null, 2)
      );
    }
    console.log(
      `[get-lessons-by-ids] Requesting ${lessonIds.length} lessons by ID:`,
      lessonIds
    );

    const { ObjectId } = require("mongodb");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Log the structure of a few lessons in the database for debugging
    console.log("🔍 DEBUG: Checking lesson structure in database...");
    const sampleLessons = await lessonsCollection.find().limit(2).toArray();
    console.log(
      "Sample lessons structure:",
      JSON.stringify(
        sampleLessons.map((l) => ({
          _id: l._id,
          lesson_title: l.lesson?.lesson_title || "No title",
          fields: Object.keys(l),
        })),
        null,
        2
      )
    );

    // ENHANCED ID PROCESSING: Handle multiple ID formats thoroughly
    const objectIds = [];
    const stringIds = [];
    const numericIds = [];

    console.log("\n📊 ID PROCESSING DETAILS 📊");
    console.log("==========================");
    console.log(`Total lesson IDs to process: ${lessonIds.length}`);

    lessonIds.forEach((id, index) => {
      // Store original form for logging
      console.log(`\n🔍 Processing ID[${index}]: "${id}", Type: ${typeof id}`);

      if (typeof id === "number") {
        numericIds.push(id);
        console.log(`  ➕ Added ${id} to numericIds array`);

        // Also try to convert to ObjectId
        try {
          const objId = new ObjectId(id.toString());
          objectIds.push(objId);
          console.log(
            `  ➕ Converted to ObjectId: ${objId} and added to objectIds array`
          );
        } catch (e) {
          console.log(
            `  ❌ Could not convert numeric ID ${id} to ObjectId: ${e.message}`
          );
        }
      } else if (typeof id === "string") {
        // Save the string version
        stringIds.push(id);
        console.log(`  ➕ Added "${id}" to stringIds array`);

        // Try to parse as number if it looks numeric
        if (/^\d+$/.test(id)) {
          const numId = parseInt(id, 10);
          numericIds.push(numId);
          console.log(
            `  ➕ Converted to number: ${numId} and added to numericIds array`
          );
        } else {
          console.log(
            `  ℹ️ ID "${id}" doesn't look like a number, not converting`
          );
        }

        // Try as ObjectId
        try {
          const objId = new ObjectId(id);
          objectIds.push(objId);
          console.log(
            `  ➕ Converted to ObjectId: ${objId} and added to objectIds array`
          );
        } catch (e) {
          console.log(
            `  ❌ Could not convert string ID "${id}" to ObjectId: ${e.message}`
          );
        }
      } else {
        console.log(`  ⚠️ Unexpected ID type: ${typeof id}, value: ${id}`);
      }
    });

    console.log("\n📋 ID PROCESSING SUMMARY 📋");
    console.log("==========================");
    console.log(
      `✅ Processed IDs: ${objectIds.length} ObjectIDs, ${stringIds.length} strings, ${numericIds.length} numbers`
    );
    if (objectIds.length > 0) {
      console.log(
        `📦 ObjectIDs: ${objectIds.map((id) => id.toString()).join(", ")}`
      );
    }
    if (stringIds.length > 0) {
      console.log(`📦 StringIDs: ${stringIds.join(", ")}`);
    }
    if (numericIds.length > 0) {
      console.log(`📦 NumericIDs: ${numericIds.join(", ")}`);
    }

    let lessonDocuments = [];

    console.log("\n🔎 DATABASE QUERY EXECUTION 🔎");
    console.log("=============================");

    // Try to find lessons using ObjectIds for the _id field
    if (objectIds.length > 0) {
      console.log("\n📌 QUERY #1: Using ObjectIds for _id field");
      console.log(
        `Query: db.Lessons.find({ _id: { $in: [${objectIds.map((id) => id.toString()).join(", ")}] } })`
      );

      try {
        const startTime = Date.now();
        const objectIdLessons = await lessonsCollection
          .find({ _id: { $in: objectIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...objectIdLessons);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(`✅ Found ${objectIdLessons.length} lessons by ObjectId`);

        if (objectIdLessons.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = objectIdLessons[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(`   - Fields: ${Object.keys(firstLesson).join(", ")}`);
          console.log(`   - Has 'lesson' property: ${!!firstLesson.lesson}`);
          if (firstLesson.lesson) {
            console.log(
              `   - Lesson title: ${firstLesson.lesson.lesson_title || "Not available"}`
            );
          }
        }
      } catch (error) {
        console.error(`❌ Error in ObjectId query: ${error.message}`);
      }
    }

    // Try to find lessons using string IDs for various ID fields
    if (stringIds.length > 0) {
      console.log("\n📌 QUERY #2: Using string IDs for lesson.lesson_id field");
      console.log(
        `Query: db.Lessons.find({ "lesson.lesson_id": { $in: ["${stringIds.join('", "')}"] } })`
      );

      try {
        const startTime = Date.now();
        const stringLessons1 = await lessonsCollection
          .find({ "lesson.lesson_id": { $in: stringIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...stringLessons1);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${stringLessons1.length} lessons by lesson.lesson_id field`
        );

        if (stringLessons1.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons1[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson.lesson_id: ${firstLesson.lesson?.lesson_id || "Not available"}`
          );
        }
      } catch (error) {
        console.error(`❌ Error in lesson.lesson_id query: ${error.message}`);
      }

      console.log("\n📌 QUERY #3: Using string IDs for lessonId field");
      console.log(
        `Query: db.Lessons.find({ "lessonId": { $in: ["${stringIds.join('", "')}"] } })`
      );

      try {
        const startTime = Date.now();
        const stringLessons2 = await lessonsCollection
          .find({ lessonId: { $in: stringIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...stringLessons2);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${stringLessons2.length} lessons by lessonId field`
        );

        if (stringLessons2.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons2[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lessonId: ${firstLesson.lessonId || "Not available"}`
          );
        }
      } catch (error) {
        console.error(`❌ Error in lessonId query: ${error.message}`);
      }

      console.log("\n📌 QUERY #4: Using string IDs for lesson_id field");
      console.log(
        `Query: db.Lessons.find({ "lesson_id": { $in: ["${stringIds.join('", "')}"] } })`
      );

      try {
        const startTime = Date.now();
        const stringLessons3 = await lessonsCollection
          .find({ lesson_id: { $in: stringIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...stringLessons3);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${stringLessons3.length} lessons by lesson_id field`
        );

        if (stringLessons3.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons3[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson_id: ${firstLesson.lesson_id || "Not available"}`
          );
        }
      } catch (error) {
        console.error(`❌ Error in lesson_id query: ${error.message}`);
      }
    }

    // Try to find lessons using numeric IDs for various ID fields
    if (numericIds.length > 0) {
      console.log(
        "\n📌 QUERY #5: Using numeric IDs for lesson.lesson_id field"
      );
      console.log(
        `Query: db.Lessons.find({ "lesson.lesson_id": { $in: [${numericIds.join(", ")}] } })`
      );

      try {
        const startTime = Date.now();
        const numericLessons1 = await lessonsCollection
          .find({ "lesson.lesson_id": { $in: numericIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...numericLessons1);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${numericLessons1.length} lessons by lesson.lesson_id field as number`
        );

        if (numericLessons1.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons1[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson.lesson_id: ${firstLesson.lesson?.lesson_id || "Not available"}`
          );
        }
      } catch (error) {
        console.error(
          `❌ Error in numeric lesson.lesson_id query: ${error.message}`
        );
      }

      console.log("\n📌 QUERY #6: Using numeric IDs for lessonId field");
      console.log(
        `Query: db.Lessons.find({ "lessonId": { $in: [${numericIds.join(", ")}] } })`
      );

      try {
        const startTime = Date.now();
        const numericLessons2 = await lessonsCollection
          .find({ lessonId: { $in: numericIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...numericLessons2);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${numericLessons2.length} lessons by lessonId field as number`
        );

        if (numericLessons2.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons2[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lessonId: ${firstLesson.lessonId || "Not available"}`
          );
        }
      } catch (error) {
        console.error(`❌ Error in numeric lessonId query: ${error.message}`);
      }

      console.log("\n📌 QUERY #7: Using numeric IDs for lesson_id field");
      console.log(
        `Query: db.Lessons.find({ "lesson_id": { $in: [${numericIds.join(", ")}] } })`
      );

      try {
        const startTime = Date.now();
        const numericLessons3 = await lessonsCollection
          .find({ lesson_id: { $in: numericIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...numericLessons3);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${numericLessons3.length} lessons by lesson_id field as number`
        );

        if (numericLessons3.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons3[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson_id: ${firstLesson.lesson_id || "Not available"}`
          );
        }
      } catch (error) {
        console.error(`❌ Error in numeric lesson_id query: ${error.message}`);
      }

      // Additional query: Try _id field directly with numbers
      console.log("\n📌 QUERY #8: Using numeric IDs for _id field directly");
      console.log(
        `Query: db.Lessons.find({ "_id": { $in: [${numericIds.join(", ")}] } })`
      );

      try {
        const startTime = Date.now();
        const numericLessons4 = await lessonsCollection
          .find({ _id: { $in: numericIds } })
          .toArray();
        const queryTime = Date.now() - startTime;

        lessonDocuments.push(...numericLessons4);
        console.log(`✅ Query completed in ${queryTime}ms`);
        console.log(
          `✅ Found ${numericLessons4.length} lessons by _id field as number`
        );

        if (numericLessons4.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons4[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(`   - Type of _id: ${typeof firstLesson._id}`);
        }
      } catch (error) {
        console.error(`❌ Error in numeric _id query: ${error.message}`);
      }
    }

    // Remove duplicates (in case a lesson was found by multiple methods)
    console.log("\n🧹 DEDUPLICATION PROCESS 🧹");
    console.log("==========================");
    console.log(
      `Total lessons found before deduplication: ${lessonDocuments.length}`
    );

    if (lessonDocuments.length > 0) {
      console.log("IDs before deduplication:");
      lessonDocuments.forEach((doc, index) => {
        console.log(`  ${index + 1}. _id: ${doc._id}, type: ${typeof doc._id}`);
      });
    }

    const uniqueLessons = lessonDocuments.filter((lesson, index, self) => {
      const firstIndex = self.findIndex(
        (l) => l._id.toString() === lesson._id.toString()
      );
      const isDuplicate = index !== firstIndex;
      if (isDuplicate) {
        console.log(
          `  ↪️ Duplicate found: ${lesson._id} (index ${index} is duplicate of index ${firstIndex})`
        );
      }
      return !isDuplicate;
    });

    console.log(
      `✅ After deduplication: ${uniqueLessons.length} unique lessons (removed ${lessonDocuments.length - uniqueLessons.length} duplicates)`
    );

    // Transform lessons to the format expected by the lesson engine
    console.log("\n🔄 LESSON TRANSFORMATION 🔄");
    console.log("==========================");

    const lessons = uniqueLessons.map((doc, index) => {
      // Log the document structure to help with debugging
      console.log(
        `\n📝 Processing lesson ${index + 1}/${uniqueLessons.length} with ID ${doc._id}:`
      );
      console.log(`  - Document fields: ${Object.keys(doc).join(", ")}`);

      if (doc.lesson) {
        console.log(
          `  - Has 'lesson' property with fields: ${Object.keys(doc.lesson).join(", ")}`
        );
      } else {
        console.log(
          `  - No 'lesson' property found, using top-level properties`
        );
      }

      // Safely extract properties, checking if they're in the doc or doc.lesson
      const getLessonProperty = (propName, defaultValue = "") => {
        if (doc[propName] !== undefined) {
          console.log(`  - Found '${propName}' at top level`);
          return doc[propName];
        }
        if (doc.lesson && doc.lesson[propName] !== undefined) {
          console.log(`  - Found '${propName}' inside lesson property`);
          return doc.lesson[propName];
        }
        console.log(
          `  - '${propName}' not found, using default: ${defaultValue}`
        );
        return defaultValue;
      };

      const transformedLesson = {
        _id: doc._id,
        lesson: doc.lesson || {}, // Keep the original nested structure
        lesson_title: getLessonProperty("lesson_title"),
        lesson_description: getLessonProperty("lesson_description"),
        lesson_type: getLessonProperty("lesson_type"),
        lesson_blocks: getLessonProperty("lesson_blocks", []),
        lesson_conditions: getLessonProperty("lesson_conditions", []),
        intro_text_blocks: getLessonProperty("intro_text_blocks", []),
        teacher: doc.teacher || "",
        unit: doc.unit || "",
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
      };

      console.log(
        `  ✅ Transformed lesson: ID=${transformedLesson._id}, Title=${transformedLesson.lesson_title || "(no title)"}`
      );
      return transformedLesson;
    });

    // Log detailed lesson content for debugging
    console.log("\n📊 LESSON CONTENT SUMMARY 📊");
    console.log("==========================");
    lessons.forEach((lesson, index) => {
      const lessonId = lesson._id.toString();
      const lessonTitle =
        lesson.lesson_title || lesson.lesson?.lesson_title || "Unknown";
      const lessonBlocks =
        lesson.lesson_blocks || lesson.lesson?.lesson_blocks || [];
      const lessonConditions =
        lesson.lesson_conditions || lesson.lesson?.lesson_conditions || [];
      const introBlocks =
        lesson.intro_text_blocks || lesson.lesson?.intro_text_blocks || [];

      console.log(`\n📚 Lesson ${index + 1}/${lessons.length}:`);
      console.log(`  - ID: ${lessonId}`);
      console.log(`  - Title: ${lessonTitle}`);
      console.log(`  - Blocks: ${lessonBlocks.length}`);
      console.log(`  - Conditions: ${lessonConditions.length}`);
      console.log(`  - Intro blocks: ${introBlocks.length}`);

      if (lessonBlocks.length > 0) {
        console.log(
          `  - First block type: ${lessonBlocks[0].type || "unknown"}`
        );
      }
    });

    res.json({
      success: true,
      lessons: lessons,
      requestedCount: lessonIds.length,
      foundCount: lessons.length,
      message: `Retrieved ${lessons.length} of ${lessonIds.length} requested lessons`,
    });

    console.log(
      "RESPONSE SENT TO CLIENT: success=true, foundCount=" + lessons.length
    );
    console.log(
      "*************************************************************\n\n"
    );
  } catch (error) {
    console.error("Failed to fetch lessons by IDs:", error);
    console.log("ERROR:", error.message);
    console.log(
      "*************************************************************\n\n"
    );
    res.status(500).json({
      success: false,
      message: "Failed to fetch lessons: " + error.message,
    });
  }
});

// Migration endpoint to assign existing ObjectIDs to admin teacher
app.post("/migrate-admin-ownership", async (req, res) => {
  try {
    console.log("--- Starting Admin Ownership Migration ---");

    const ADMIN_TEACHER = "admin@trinity-capital.net";
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Get all lessons without teacher ownership or with null teacher
    const unownedLessons = await lessonsCollection
      .find({
        $or: [
          { teacher: { $exists: false } },
          { teacher: null },
          { teacher: "" },
        ],
      })
      .toArray();

    console.log(
      `Found ${unownedLessons.length} unowned lessons to assign to admin`
    );

    // Assign all unowned lessons to admin
    const bulkOps = unownedLessons.map((lesson) => ({
      updateOne: {
        filter: { _id: lesson._id },
        update: {
          $set: { teacher: ADMIN_TEACHER, migratedToAdmin: new Date() },
        },
      },
    }));

    if (bulkOps.length > 0) {
      const bulkResult = await lessonsCollection.bulkWrite(bulkOps);
      console.log(
        `Assigned ${bulkResult.modifiedCount} lessons to admin teacher`
      );
    }

    // Create admin teacher document if it doesn't exist
    const adminTeacher = await teachersCollection.findOne({
      name: ADMIN_TEACHER,
    });
    if (!adminTeacher) {
      await teachersCollection.insertOne({
        name: ADMIN_TEACHER,
        units: [],
        createdAt: new Date(),
        isAdminAccount: true,
      });
      console.log("Created admin teacher document");
    }

    res.json({
      success: true,
      message: "Admin ownership migration completed",
      lessonsAssigned: bulkOps.length,
      adminTeacherExists: !!adminTeacher,
    });
  } catch (error) {
    console.error("Migration failed:", error);
    res.status(500).json({
      success: false,
      message: "Migration failed: " + error.message,
    });
  }
});

// Get lessons created by admin@trinity-capital.net for testing
app.get("/admin-lessons", async (req, res) => {
  try {
    const lessons = await client
      .db("TrinityCapital")
      .collection("Lessons")
      .find({
        teacher: "admin@trinity-capital.net",
      })
      .limit(10) // Limit to 10 lessons for testing
      .toArray();

    console.log(
      `Found ${lessons.length} lessons created by admin@trinity-capital.net`
    );

    res.json({
      success: true,
      lessons: lessons,
      count: lessons.length,
    });
  } catch (error) {
    console.error("Error fetching admin lessons:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch admin lessons",
      message: error.message,
    });
  }
});

// API endpoint to fetch lessons for a student by studentId (student name) - for frontend
app.get("/lessons", async (req, res) => {
  try {
    const { studentId } = req.query;
    if (!studentId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing studentId" });
    }

    // Find the student's profile
    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");
    const studentProfile = await profilesCollection.findOne({
      memberName: studentId,
    });

    if (!studentProfile) {
      console.log(`[LESSON API] No profile found for memberName: ${studentId}`);
      return res
        .status(404)
        .json({ success: false, message: "Student not found" });
    }

    // Collect all lessonIds from assignedUnitIds
    const assignedUnits = Array.isArray(studentProfile.assignedUnitIds)
      ? studentProfile.assignedUnitIds
      : [];
    let allLessonIds = [];
    assignedUnits.forEach((unit) => {
      if (Array.isArray(unit.lessonIds)) {
        allLessonIds.push(...unit.lessonIds);
      }
    });

    // Remove duplicates and filter falsy values
    allLessonIds = [...new Set(allLessonIds)].filter(Boolean);

    if (allLessonIds.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch lessons from Lessons collection by _id
    const { ObjectId } = require("mongodb");
    const studentLessonsCollection = client
      .db("TrinityCapital")
      .collection("Lessons");
    const lessonIdQuery = allLessonIds.map((id) => {
      if (
        typeof id === "string" &&
        id.length === 24 &&
        /^[a-fA-F0-9]+$/.test(id)
      ) {
        try {
          return new ObjectId(id);
        } catch (e) {
          return id;
        }
      }
      if (typeof id === "string" && /^\d+$/.test(id)) {
        return Number(id);
      }
      return id;
    });
    const lessonDocs = await studentLessonsCollection
      .find({
        _id: { $in: lessonIdQuery },
      })
      .toArray();

    // Format lessons for frontend
    const lessons = lessonDocs.map((doc) => {
      const getLessonProperty = (propName, defaultValue = "") => {
        if (doc[propName] !== undefined) {
          return doc[propName];
        }
        if (doc.lesson && doc.lesson[propName] !== undefined) {
          return doc.lesson[propName];
        }
        return defaultValue;
      };

      return {
        _id: doc._id,
        lesson_title: getLessonProperty("lesson_title"),
        lesson_description: getLessonProperty("lesson_description"),
        lesson_type: getLessonProperty("lesson_type"),
        content: getLessonProperty("content", []),
        completion_conditions: getLessonProperty("lesson_conditions", []),
        learning_objectives: getLessonProperty("learning_objectives", []),
        unit: getLessonProperty("unit"),
        teacher: getLessonProperty("teacher"),
        createdAt: getLessonProperty("createdAt"),
        dallas_fed_aligned: getLessonProperty("dallas_fed_aligned"),
        teks_standards: getLessonProperty("teks_standards", []),
        day: getLessonProperty("day"),
        status: getLessonProperty("status"),
        difficulty_level: getLessonProperty("difficulty_level"),
        estimated_duration: getLessonProperty("estimated_duration"),
        required_actions: getLessonProperty("required_actions", []),
        success_metrics: getLessonProperty("success_metrics", {}),
        updated_at: getLessonProperty("updated_at"),
        condition_alignment: getLessonProperty("condition_alignment"),
        structure_cleaned: getLessonProperty("structure_cleaned"),
      };
    });

    res.status(200).json(lessons);
  } catch (error) {
    console.error("Failed to fetch lessons for student:", error);
    res.status(500).json([]);
  }
});

// API endpoint to fetch lessons for a student by studentId (student name)
app.get("/api/student-lessons/:studentId", async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing studentId" });
    }

    // Find the student's profile
    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");
    const studentProfile = await profilesCollection.findOne({
      memberName: studentId,
    });

    if (!studentProfile) {
      console.log(`[LESSON API] No profile found for memberName: ${studentId}`);
      return res
        .status(404)
        .json({ success: false, message: "Student not found" });
    }

    // Debug: Log the full student profile
    console.log(
      `[LESSON API] Full profile for ${studentId}:`,
      JSON.stringify(studentProfile, null, 2)
    );

    // Debug: Log the student profile's assignedUnitIds
    console.log(
      `[LESSON API] Profile for ${studentId}: assignedUnitIds:`,
      studentProfile.assignedUnitIds
    );

    // Collect all lessonIds from assignedUnitIds
    const assignedUnits = Array.isArray(studentProfile.assignedUnitIds)
      ? studentProfile.assignedUnitIds
      : [];
    console.log(
      `[LESSON API] assignedUnits array:`,
      JSON.stringify(assignedUnits, null, 2)
    );
    let allLessonIds = [];
    assignedUnits.forEach((unit, idx) => {
      console.log(`[LESSON API] Unit[${idx}]`, JSON.stringify(unit, null, 2));
      if (Array.isArray(unit.lessonIds)) {
        allLessonIds.push(...unit.lessonIds);
      }
    });

    // Remove duplicates and filter falsy values
    allLessonIds = [...new Set(allLessonIds)].filter(Boolean);
    console.log(`[LESSON API] All lessonIds collected:`, allLessonIds);

    if (allLessonIds.length === 0) {
      console.log(`[LESSON API] No lessonIds found for student: ${studentId}`);
      return res.status(200).json({
        success: true,
        lessons: [],
        message: "No lessons assigned to student.",
      });
    }

    // Fetch lessons from Lessons collection by _id (convert string IDs to ObjectId if possible)
    const { ObjectId } = require("mongodb");
    const studentLessonsCollection = client
      .db("TrinityCapital")
      .collection("Lessons");
    // Convert all IDs to ObjectId if valid, else keep as string
    const lessonIdQuery = allLessonIds.map((id) => {
      // Convert to ObjectId if 24-char hex string
      if (
        typeof id === "string" &&
        id.length === 24 &&
        /^[a-fA-F0-9]+$/.test(id)
      ) {
        try {
          return new ObjectId(id);
        } catch (e) {
          return id;
        }
      }
      // Convert to number if numeric string
      if (typeof id === "string" && /^\d+$/.test(id)) {
        return Number(id);
      }
      return id;
    });
    const lessonDocs = await studentLessonsCollection
      .find({
        _id: { $in: lessonIdQuery },
      })
      .toArray();

    // Debug: Log found lessons
    console.log(
      `[LESSON API] Found ${lessonDocs.length} lessons for student: ${studentId}`
    );
    lessonDocs.forEach((doc, idx) => {
      console.log(
        `[LESSON API] Lesson[${idx}]: _id=${doc._id}, title=${doc.lesson?.lesson_title}`
      );
    });

    // Format lessons for frontend (flatten lesson object)
    const lessons = lessonDocs.map((doc) => ({
      _id: doc._id,
      ...doc.lesson,
    }));

    console.log(
      `[LESSON API] Returning ${lessons.length} lessons to frontend for student: ${studentId}`
    );
    res.status(200).json({
      success: true,
      lessons,
      message: `Retrieved ${lessons.length} lessons for student.`,
    });
  } catch (error) {
    console.error("Failed to fetch lessons for student:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lessons for student.",
    });
  }
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Validate all routes to ensure they don't have path-to-regexp issues
// This is for debugging purposes only - it won't fix the routes but will help identify issues
function validateRoutes() {
  const router = app._router;
  if (!router) {
    console.log("No router found on Express app");
    return;
  }

  console.log("\n===== ROUTE VALIDATION =====");

  // Get all routes from the Express router
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      const methods = Object.keys(route.methods)
        .map((m) => m.toUpperCase())
        .join(",");
      return {
        path: route.path,
        methods: methods || "UNKNOWN",
        hasParams: route.path.includes(":"),
      };
    });

  console.log(`Found ${routes.length} routes`);

  // Check routes with parameters for potential issues
  const routesWithParams = routes.filter((r) => r.hasParams);
  console.log(`Found ${routesWithParams.length} routes with parameters`);

  routesWithParams.forEach((route) => {
    console.log(`- [${route.methods}] ${route.path}`);

    // Check for common route parameter issues
    if (route.path.includes("::")) {
      console.error(`  ⚠️ WARNING: Double colons in route path: ${route.path}`);
    }

    if (route.path.includes(":") && route.path.includes("?")) {
      console.error(
        `  ⚠️ WARNING: Both colon and question mark in route path: ${route.path}`
      );
    }

    // Split the path into segments and check each parameter
    const segments = route.path.split("/");
    segments.forEach((segment) => {
      if (segment.startsWith(":")) {
        const paramName = segment.substring(1);
        if (!paramName || paramName.length === 0) {
          console.error(
            `  ⚠️ WARNING: Empty parameter name in route path: ${route.path}`
          );
        }
        if (
          paramName.includes(":") ||
          paramName.includes("/") ||
          paramName.includes("?")
        ) {
          console.error(
            `  ⚠️ WARNING: Invalid character in parameter name '${paramName}' in route path: ${route.path}`
          );
        }
      }
    });
  });

  console.log("===== END ROUTE VALIDATION =====\n");
}

// Run validation after all routes are registered
validateRoutes();
