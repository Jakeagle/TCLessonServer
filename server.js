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

    // --- Fetch updated unit data from database before emitting events ---
    const updatedTeacherDoc = await teachersCollection.findOne(
      { name: teacher },
      { projection: { units: 1, _id: 0 } }
    );

    let updatedUnit = null;
    if (updatedTeacherDoc && updatedTeacherDoc.units) {
      updatedUnit = updatedTeacherDoc.units.find((u) => u.value === unit.value);
    }

    // Fallback to original unit data if fetch fails
    const unitToEmit = updatedUnit || unit;

    console.log("--- Debug: Unit data being emitted ---");
    console.log("Unit name:", unitToEmit.name);
    console.log("Unit value:", unitToEmit.value);
    console.log(
      "Number of lessons in unit:",
      unitToEmit.lessons ? unitToEmit.lessons.length : 0
    );
    if (unitToEmit.lessons && unitToEmit.lessons.length > 0) {
      console.log(
        "Lesson titles:",
        unitToEmit.lessons.map((l) => l.lesson_title)
      );
    }

    // --- 3. Emit Socket.IO event to update lesson management modal ---
    io.emit("lessonCreated", {
      teacherName: teacher,
      lessonData: {
        _id: lessonInsertResult.insertedId,
        ...lesson,
      },
      unitData: unitToEmit,
    });

    // Emit event specifically for lesson management modal refresh
    io.emit("lessonManagementRefresh", {
      teacherName: teacher,
      action: "lessonAdded",
      lessonData: {
        _id: lessonInsertResult.insertedId,
        ...lesson,
      },
      unitData: unitToEmit,
    });

    // Emit to teacher-specific lesson management room
    io.to(`lessonManagement-${teacher}`).emit("newLessonAdded", {
      teacherName: teacher,
      lessonData: {
        _id: lessonInsertResult.insertedId,
        ...lesson,
      },
      unitData: unitToEmit,
      timestamp: new Date().toISOString(),
    });

    console.log(`--- Socket events emitted for lesson creation ---`);
    console.log(
      `Events: lessonCreated, unitUpdated, lessonManagementRefresh, newLessonAdded`
    );
    console.log(`Teacher: ${teacher}`);
    console.log(`Unit: ${unitToEmit.name} (${unitToEmit.value})`);
    console.log(`Lesson: ${lesson.lesson_title}`);
    console.log(
      `Lessons in unit after creation: ${unitToEmit.lessons ? unitToEmit.lessons.length : 0}`
    );
    console.log("--- End debug info ---");

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

    // Emit event specifically for lesson management modal refresh
    io.emit("lessonManagementRefresh", {
      teacherName: teacherName,
      action: "unitAssigned",
      unitData: assignedUnit,
      classPeriod: classPeriod,
    });

    // Emit to teacher-specific lesson management room
    io.to(`lessonManagement-${teacherName}`).emit("unitAssignmentUpdated", {
      teacherName: teacherName,
      unitData: assignedUnit,
      classPeriod: classPeriod,
      timestamp: new Date().toISOString(),
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

      // Get master teacher's lessons
      const masterLessonsData = await lessonsCollection
        .find({ teacher: MASTER_TEACHER })
        .project({ lesson: 1, _id: 1 })
        .toArray();

      masterLessons = masterLessonsData.map((item) => ({
        _id: item._id,
        ...item.lesson,
        isMasterContent: true, // Flag to identify master content
      }));

      console.log(
        `Found ${masterLessons.length} master lessons from ${MASTER_TEACHER}.`
      );
    }

    // Fetch teacher's own lessons
    const teacherLessons = await lessonsCollection
      .find({ teacher: teacherName })
      .project({ lesson: 1, _id: 1 })
      .toArray();

    const teacherFlattenedLessons = teacherLessons.map((item) => ({
      _id: item._id,
      ...item.lesson,
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

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
