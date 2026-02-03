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

console.log("========================================");
console.log("🔗 MongoDB Connection URI:");
console.log("   ", mongoUri);
console.log("   (Check if this matches your MongoDB Atlas connection)");
console.log("========================================");
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
  }),
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
    "Content-Type, Authorization, Origin, X-Requested-With, Accept",
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
      "Pinged your deployment. You successfully connected to MongoDB!",
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

    // --- 1. Save the lesson to the "Lessons" collection with proper structure ---
    // Store all fields at the top level for proper retrieval by student frontend
    const lessonDocument = {
      _id: Date.now(), // Generate numeric ID
      teacher,
      unit,
      // Top-level fields (what student frontend expects)
      lesson_title: lesson.lesson_title || "",
      lesson_description: lesson.lesson_description || "",
      content: lesson.content || [],
      lesson_blocks: lesson.lesson_blocks || [],
      intro_text_blocks: lesson.intro_text_blocks || [],
      learning_objectives: lesson.learning_objectives || [],
      lesson_conditions: lesson.lesson_conditions || [],
      required_actions: lesson.required_actions || [],
      success_metrics: lesson.success_metrics || {},
      teks_standards: lesson.teks_standards || [],
      day: lesson.day,
      status: lesson.status || "active",
      difficulty_level: lesson.difficulty_level,
      estimated_duration: lesson.estimated_duration,
      dallas_fed_aligned: lesson.dallas_fed_aligned,
      condition_alignment: lesson.condition_alignment,
      structure_cleaned: lesson.structure_cleaned,
      createdAt: new Date(),
    };
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");
    const lessonInsertResult =
      await lessonsCollection.insertOne(lessonDocument);
    const numericLessonId = lessonDocument._id.toString();

    console.log(
      `Lesson saved to 'Lessons' collection with id: ${numericLessonId}`,
    );

    // --- 2. Update the teacher's document in the "Teachers" collection ---
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    // Create MINIMAL lesson reference object - only _id, lesson_title, lesson_description
    // Full content will be fetched from Lessons collection when needed
    const lessonReference = {
      _id: numericLessonId,
      lesson_title: lesson.lesson_title || "",
      lesson_description: lesson.lesson_description || "",
    };

    // Step 2a: Try to push the lesson into an existing unit's 'lessons' array
    // Use unit.name to find the unit since that's what's displayed to users
    console.log(`🔍 Looking for unit by name: "${unit.name}"`);

    const updateResult = await teachersCollection.updateOne(
      { name: teacher, "units.name": unit.name },
      { $push: { "units.$.lessons": lessonReference } },
    );

    console.log(
      `✓ Save lesson - Update result: matched=${updateResult.matchedCount}, modified=${updateResult.modifiedCount}`,
    );

    // Step 2b: If the unit didn't exist for that teacher, add the new unit to the teacher's 'units' array.
    if (updateResult.matchedCount === 0) {
      console.warn(
        `⚠️ Unit '${unit.name}' not found for teacher '${teacher}'. Creating new unit...`,
      );
      // This update handles cases where the 'units' array exists but the specific unit doesn't,
      // or where the 'units' array doesn't exist at all.
      const addUnitResult = await teachersCollection.updateOne(
        { name: teacher },
        { $push: { units: { ...unit, lessons: [lessonReference] } } },
      );

      console.log(
        `✓ Save lesson - Add unit result: matched=${addUnitResult.matchedCount}, modified=${addUnitResult.modifiedCount}`,
      );

      // If this second update also fails to find a match, it means the teacher doesn't exist.
      if (addUnitResult.matchedCount === 0) {
        console.error(
          `❌ Teacher '${teacher}' not found in 'Teachers' collection. Lesson was saved to 'Lessons' but not added to teacher profile.`,
        );
      }
    }

    console.log(
      `✅ Lesson "${lesson.lesson_title}" saved to unit "${unit.name}" for teacher "${teacher}"`,
    );

    // --- 3. Assign lesson to all students with this teacher ---
    console.log(`\n📚 ASSIGNING LESSON TO STUDENTS:`);
    console.log(`Looking for students with teacher: "${teacher}"`);

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Use the numeric ID of the lesson (already a string)
    console.log(`Lesson numeric ID: ${numericLessonId}`);

    // Find all students assigned to this teacher
    const studentsWithTeacher = await profilesCollection
      .find({ teacher: teacher })
      .toArray();

    console.log(
      `Found ${studentsWithTeacher.length} students assigned to teacher "${teacher}"`,
    );

    // Update each student to add this lesson to their unit's lessonIds
    if (studentsWithTeacher.length > 0) {
      for (const student of studentsWithTeacher) {
        // Check if student has assignedUnitIds
        if (
          student.assignedUnitIds &&
          Array.isArray(student.assignedUnitIds) &&
          student.assignedUnitIds.length > 0
        ) {
          // Find the unit assignment that matches this unit
          const unitAssignmentIndex = student.assignedUnitIds.findIndex(
            (assignment) =>
              assignment.unitName === unit.name ||
              assignment.unitValue === unit.value,
          );

          if (unitAssignmentIndex !== -1) {
            // Unit assignment found - add lesson to lessonIds
            console.log(
              `  ✓ Adding lesson to student "${student.memberName}" in unit "${unit.name}"`,
            );

            // Ensure lessonIds array exists
            if (
              !student.assignedUnitIds[unitAssignmentIndex].lessonIds ||
              !Array.isArray(
                student.assignedUnitIds[unitAssignmentIndex].lessonIds,
              )
            ) {
              student.assignedUnitIds[unitAssignmentIndex].lessonIds = [];
            }

            // Add the lesson ID if it's not already there (keep as string for consistency)
            if (
              !student.assignedUnitIds[unitAssignmentIndex].lessonIds.includes(
                numericLessonId,
              )
            ) {
              student.assignedUnitIds[unitAssignmentIndex].lessonIds.push(
                numericLessonId,
              );

              // Update the student profile
              await profilesCollection.updateOne(
                { memberName: student.memberName },
                { $set: { assignedUnitIds: student.assignedUnitIds } },
              );
            }
          } else {
            console.log(
              `  ⚠️ Student "${student.memberName}" not assigned to unit "${unit.name}"`,
            );
          }
        } else {
          console.log(
            `  ⚠️ Student "${student.memberName}" has no assigned units`,
          );
        }
      }
    }

    console.log(
      `✅ Lesson assignment to students completed for unit "${unit.name}"\n`,
    );

    // --- Fetch updated unit data from database before emitting events ---
    const updatedTeacherDoc = await teachersCollection.findOne(
      { name: teacher },
      { projection: { units: 1, _id: 0 } },
    );

    res.status(201).json({ success: true, lessonId: numericLessonId });
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

    const { ObjectId } = require("mongodb");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Parse lesson ID
    let query = {};
    const numericId = parseInt(lessonId, 10);

    if (!isNaN(numericId)) {
      query = { _id: numericId };
    } else {
      try {
        query = { _id: new ObjectId(lessonId) };
      } catch (e) {
        query = { _id: lessonId };
      }
    }

    console.log("Query for lesson update:", query);

    // --- FETCH EXISTING LESSON FIRST ---
    // This ensures we preserve ALL existing data that isn't being updated
    const existingLesson = await lessonsCollection.findOne(query);

    if (!existingLesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found - cannot update non-existent lesson",
      });
    }

    // Get the existing lesson object (or empty if doesn't exist)
    const existingLessonData = existingLesson.lesson || {};

    // --- SAFE MERGE: Only override fields that are explicitly provided ---
    // This preserves lesson_blocks, intro_text_blocks, and any other existing data
    const lessonDocument = {
      _id: numericId || lessonId,
      lesson: {
        // Preserve existing fields first
        ...existingLessonData,
        // Then override only with provided fields
        lesson_title:
          lesson.lesson_title !== undefined
            ? lesson.lesson_title
            : existingLessonData.lesson_title || "",
        lesson_description:
          lesson.lesson_description !== undefined
            ? lesson.lesson_description
            : existingLessonData.lesson_description || "",
        unit:
          lesson.unit !== undefined
            ? lesson.unit
            : existingLessonData.unit || unit.name || "",
        content:
          lesson.content !== undefined
            ? lesson.content
            : existingLessonData.content || [],
        lesson_blocks:
          lesson.lesson_blocks !== undefined
            ? lesson.lesson_blocks
            : existingLessonData.lesson_blocks || [],
        intro_text_blocks:
          lesson.intro_text_blocks !== undefined
            ? lesson.intro_text_blocks
            : existingLessonData.intro_text_blocks || [],
        learning_objectives:
          lesson.learning_objectives !== undefined
            ? lesson.learning_objectives
            : existingLessonData.learning_objectives || [],
        creator_email:
          lesson.creator_email !== undefined
            ? lesson.creator_email
            : existingLessonData.creator_email || teacher,
        creator_username:
          lesson.creator_username !== undefined
            ? lesson.creator_username
            : existingLessonData.creator_username || "adminTC",
        teacher:
          lesson.teacher !== undefined
            ? lesson.teacher
            : existingLessonData.teacher || teacher,
        createdAt: existingLessonData.createdAt || new Date(),
        dallas_fed_aligned:
          lesson.dallas_fed_aligned !== undefined
            ? typeof lesson.dallas_fed_aligned === "boolean"
              ? lesson.dallas_fed_aligned
              : existingLessonData.dallas_fed_aligned !== undefined
                ? existingLessonData.dallas_fed_aligned
                : true
            : existingLessonData.dallas_fed_aligned !== undefined
              ? existingLessonData.dallas_fed_aligned
              : true,
        teks_standards:
          lesson.teks_standards !== undefined
            ? lesson.teks_standards
            : existingLessonData.teks_standards || [],
        day:
          lesson.day !== undefined
            ? lesson.day
            : existingLessonData.day || null,
        status:
          lesson.status !== undefined
            ? lesson.status
            : existingLessonData.status || "active",
        difficulty_level:
          lesson.difficulty_level !== undefined
            ? lesson.difficulty_level
            : existingLessonData.difficulty_level || null,
        estimated_duration:
          lesson.estimated_duration !== undefined
            ? lesson.estimated_duration
            : existingLessonData.estimated_duration || null,
        condition_alignment:
          lesson.condition_alignment !== undefined
            ? lesson.condition_alignment
            : existingLessonData.condition_alignment ||
              "teacher_dashboard_compatible",
        structure_cleaned: true,
        updatedAt: new Date(),
        lesson_conditions: (
          lesson.lesson_conditions ||
          existingLessonData.lesson_conditions ||
          []
        ).map((cond) => ({
          condition_type: cond.condition_type,
          condition_value:
            cond.condition_value !== null && cond.condition_value !== undefined
              ? cond.condition_value
              : cond.value,
          action_type: cond.action_type || null,
          ...(cond.action_details && { action_details: cond.action_details }),
          ...(cond.action && { action: cond.action }),
        })),
        required_actions:
          lesson.required_actions ||
          (
            lesson.lesson_conditions ||
            existingLessonData.lesson_conditions ||
            []
          ).map((c) => c.condition_type),
        success_metrics: lesson.success_metrics ||
          existingLessonData.success_metrics || {
            minimum_conditions_met: Math.max(
              Math.floor(
                (
                  lesson.lesson_conditions ||
                  existingLessonData.lesson_conditions ||
                  []
                ).length * 0.66,
              ),
              2,
            ),
            time_limit_minutes: 30,
            engagement_score_minimum: 60,
            updated_at: new Date(),
            condition_alignment: "teacher_dashboard_compatible",
            structure_cleaned: true,
          },
      },
      teacher: lesson.teacher || existingLesson.teacher || teacher,
      unit: lesson.unit || existingLesson.unit || unit.name || "",
      createdAt: existingLesson.createdAt || new Date(),
    };

    const lessonUpdateResult = await lessonsCollection.replaceOne(
      query,
      lessonDocument,
    );

    if (lessonUpdateResult.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found in Lessons collection",
      });
    }

    console.log(
      "✅ Lesson updated in 'Lessons' collection with STRICT nested structure",
    );

    // --- 2. Update minimal reference in Teachers collection ---
    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    const lessonReference = {
      _id: lessonId.toString(),
      lesson_title: lesson.lesson_title || "",
      lesson_description: lesson.lesson_description || "",
    };

    console.log(
      `🔍 Looking for lesson to update in unit "${unit.name}" with ID ${lessonId}`,
    );

    const teacherUpdateResult = await teachersCollection.updateOne(
      {
        name: teacher,
        "units.name": unit.name,
        "units.lessons._id": lessonId.toString(),
      },
      {
        $set: {
          "units.$[unit].lessons.$[lesson]": lessonReference,
        },
      },
      {
        arrayFilters: [
          { "unit.name": unit.name },
          { "lesson._id": lessonId.toString() },
        ],
      },
    );

    console.log(
      `✓ Update lesson reference in Teachers - matched=${teacherUpdateResult.matchedCount}, modified=${teacherUpdateResult.modifiedCount}`,
    );

    // If lesson wasn't found, add it
    if (teacherUpdateResult.matchedCount === 0) {
      console.log(
        `⚠️ Lesson not found in unit "${unit.name}". Adding as new reference...`,
      );
      const addLessonResult = await teachersCollection.updateOne(
        { name: teacher, "units.name": unit.name },
        { $push: { "units.$.lessons": lessonReference } },
      );
      console.log(
        `✓ Add lesson reference - matched=${addLessonResult.matchedCount}, modified=${addLessonResult.modifiedCount}`,
      );
    }

    // --- 3. Assign lesson to students ---
    console.log(`\n📚 ASSIGNING UPDATED LESSON TO STUDENTS:`);
    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");
    const lessonIdString = lessonId.toString();

    const studentsWithTeacher = await profilesCollection
      .find({ teacher: teacher })
      .toArray();
    console.log(
      `Found ${studentsWithTeacher.length} students assigned to teacher "${teacher}"`,
    );

    if (studentsWithTeacher.length > 0) {
      for (const student of studentsWithTeacher) {
        if (
          student.assignedUnitIds &&
          Array.isArray(student.assignedUnitIds) &&
          student.assignedUnitIds.length > 0
        ) {
          const unitAssignmentIndex = student.assignedUnitIds.findIndex(
            (assignment) =>
              assignment.unitName === unit.name ||
              assignment.unitValue === unit.value,
          );

          if (unitAssignmentIndex !== -1) {
            console.log(
              `  ✓ Adding updated lesson to student "${student.memberName}"`,
            );
            if (!student.assignedUnitIds[unitAssignmentIndex].lessonIds) {
              student.assignedUnitIds[unitAssignmentIndex].lessonIds = [];
            }
            if (
              !student.assignedUnitIds[unitAssignmentIndex].lessonIds.includes(
                lessonIdString,
              )
            ) {
              student.assignedUnitIds[unitAssignmentIndex].lessonIds.push(
                lessonIdString,
              );
              await profilesCollection.updateOne(
                { memberName: student.memberName },
                { $set: { assignedUnitIds: student.assignedUnitIds } },
              );
            }
          }
        }
      }
    }

    console.log(`✅ Lesson update assignment completed\n`);

    io.emit("lessonUpdated", {
      teacherName: teacher,
      lessonData: { _id: lessonId, ...lesson },
      unitData: unit,
    });

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

// PRODUCTION: Fetch any lesson by ID (for editing admin-created lessons)
// PRODUCTION: Fetch any lesson by numeric ID (for editing admin-created lessons)
// Returns the complete lesson object with all content from Lessons collection
app.get("/lesson/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;

    console.log("--- Get Lesson by ID Request ---");
    console.log("Lesson ID:", lessonId);

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Try to find lesson by numeric ID first
    let numericId = parseInt(lessonId, 10);
    let lesson = null;

    if (!isNaN(numericId)) {
      // If it's a valid number, search by numeric _id
      lesson = await lessonsCollection.findOne({
        _id: numericId,
      });
    }

    // If not found as numeric, try as string or ObjectId
    if (!lesson) {
      const { ObjectId } = require("mongodb");
      try {
        lesson = await lessonsCollection.findOne({
          _id: new ObjectId(lessonId),
        });
      } catch (e) {
        // Not a valid ObjectId, try as string
        lesson = await lessonsCollection.findOne({
          _id: lessonId,
        });
      }
    }

    if (!lesson) {
      console.log(`Lesson not found: ${lessonId}`);
      return res.status(404).json({
        success: false,
        message: "Lesson not found",
      });
    }

    // Return the complete lesson object with all content
    // The lesson object contains everything: lesson_blocks, lesson_conditions, intro_text_blocks, etc.
    // Note: lesson_conditions may be at top level OR inside lesson.lesson
    const completeLesson = {
      _id: lesson._id,
      teacher: lesson.teacher,
      unit: lesson.unit,
      createdAt: lesson.createdAt,
      updatedAt: lesson.updatedAt,
      // Get lesson_title from top level FIRST, then fallback to nested if needed
      lesson_title:
        lesson.lesson_title ||
        (lesson.lesson && lesson.lesson.lesson_title) ||
        "",
      lesson_description:
        lesson.lesson_description ||
        (lesson.lesson && lesson.lesson.lesson_description) ||
        "",
      // Include ALL lesson content properties from nested lesson object
      ...(lesson.lesson || {}),
      // Also include top-level properties that might not be in lesson.lesson
      // (handles both storage formats)
      ...(lesson.lesson_conditions && {
        lesson_conditions: lesson.lesson_conditions,
      }),
      ...(lesson.content && { content: lesson.content }),
      ...(lesson.learning_objectives && {
        learning_objectives: lesson.learning_objectives,
      }),
      ...(lesson.lesson_blocks && { lesson_blocks: lesson.lesson_blocks }),
      ...(lesson.intro_text_blocks && {
        intro_text_blocks: lesson.intro_text_blocks,
      }),
      ...(lesson.required_actions && {
        required_actions: lesson.required_actions,
      }),
      ...(lesson.success_metrics && {
        success_metrics: lesson.success_metrics,
      }),
    };

    console.log(
      `Retrieved complete lesson: ${completeLesson.lesson_title || "Untitled"}`,
    );
    console.log(
      `Lesson has ${completeLesson.lesson_blocks ? completeLesson.lesson_blocks.length : 0} blocks`,
    );
    console.log(
      `Lesson has ${completeLesson.content ? completeLesson.content.length : 0} content items`,
    );
    console.log(
      `Lesson has ${completeLesson.lesson_conditions ? completeLesson.lesson_conditions.length : 0} conditions`,
    );
    console.log(
      "🔍 DEBUG: Complete lesson fields being sent:",
      Object.keys(completeLesson),
    );
    console.log(
      "🔍 DEBUG: lesson_conditions value:",
      completeLesson.lesson_conditions,
    );

    res.status(200).json({
      success: true,
      lesson: completeLesson,
    });
  } catch (error) {
    console.error("Failed to fetch lesson:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lesson: " + error.message,
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
        JSON.stringify(lesson, null, 2),
      );
    } else {
      console.log(
        "Received data for Whirlpool, but 'lesson' object not found. Full body:",
        JSON.stringify(req.body, null, 2),
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
      `Searching for lesson with Title: "${lessonTitle}", Unit: "${unitName}", Teacher: "${teacher}"`,
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
      { $unset: { "units.$.assigned_to_period": "" } },
    );

    // Step 2: Assign the period to the selected unit.
    const updateResult = await teachersCollection.updateOne(
      { name: teacherName, "units.value": unitValue },
      { $set: { "units.$.assigned_to_period": classPeriod } },
    );

    if (updateResult.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher or unit not found." });
    }

    // Step 3: Fetch the unit that was just assigned.
    const teacherDoc = await teachersCollection.findOne(
      { name: teacherName },
      { projection: { units: 1, _id: 0 } },
    );

    if (!teacherDoc || !teacherDoc.units) {
      return res.status(404).json({
        success: false,
        message: "Could not retrieve teacher's units after assignment.",
      });
    }

    // Find the unit that is now assigned to the class period.
    const assignedUnit = teacherDoc.units.find(
      (u) => u.assigned_to_period === classPeriod,
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
      assignedUnit.lessons ? assignedUnit.lessons.length : 0,
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
            `✓ Lesson "${lesson.lesson_title}" has ID: ${lesson._id}`,
          );
        } else {
          console.log(
            `⚠ Lesson "${lesson.lesson_title}" missing _id - will try to find in Lessons collection`,
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
                `✓ Found matching lesson in Lessons collection with ID: ${foundLesson._id}`,
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
                },
              );
              console.log(
                `✓ Updated teacher's unit with missing _id for lesson: ${lesson.lesson_title}`,
              );
            } else {
              console.log(
                `✗ Could not find lesson "${lesson.lesson_title}" in Lessons collection`,
              );
            }
          } catch (error) {
            console.error(
              `Error looking up lesson "${lesson.lesson_title}":`,
              error,
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
      JSON.stringify(unitAssignment, null, 2),
    );
    console.log(
      `Will assign ${unitAssignment.lessonIds.length} lesson ObjectIDs to students`,
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
        { projection: { memberName: 1, _id: 0 } },
      )
      .toArray();

    console.log("--- Students to be updated ---");
    console.log(
      `Found ${studentsToUpdate.length} students:`,
      studentsToUpdate.map((s) => s.memberName),
    );

    // Step 4: Update students with ObjectID-based assignment (remove duplicates)
    const studentUpdateResult = await profilesCollection.updateMany(
      { teacher: teacherName, classPeriod: classPeriodAsNumber },
      {
        $addToSet: {
          assignedUnitIds: unitAssignment, // Use addToSet to prevent duplicates
        },
      },
    );

    console.log(
      `✅ ASSIGNED UNIT REFERENCES to ${studentUpdateResult.modifiedCount} students`,
    );
    console.log(
      `Each student now has ObjectID references for unit: ${assignedUnit.name}`,
    );
    console.log(
      `Lesson ObjectIDs assigned: ${unitAssignment.lessonIds.join(", ")}`,
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
      `✅ Emitted unitAssignedToStudent events for ${studentsToUpdate.length} students`,
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
      { projection: { units: 1, _id: 0 } }, // Only get the units field, exclude _id
    );

    // Fetch master teacher's content as defaults
    let masterUnits = [];
    let masterLessons = [];

    if (teacherName !== MASTER_TEACHER) {
      console.log(`Fetching master content from ${MASTER_TEACHER}...`);

      // Get master teacher's units
      const masterTeacherDocument = await teachersCollection.findOne(
        { name: MASTER_TEACHER },
        { projection: { units: 1, _id: 0 } },
      );

      if (masterTeacherDocument && masterTeacherDocument.units) {
        masterUnits = masterTeacherDocument.units;
        console.log(
          `Found ${masterUnits.length} master units from ${MASTER_TEACHER}.`,
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
        `Found ${masterLessons.length} master lessons from ${MASTER_TEACHER}.`,
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
          teacherUnits.map((unit) => unit.value),
        );
        const remainingDefaultUnits = masterUnits
          .filter((unit) => !customUnitValues.has(unit.value))
          .map((unit) => ({
            ...unit,
            isDefaultUnit: true, // Flag to indicate this is a default unit
          }));

        combinedUnits.push(...remainingDefaultUnits);

        console.log(
          `Using teacher's ${teacherUnits.length} custom units + ${remainingDefaultUnits.length} remaining default units`,
        );
      } else {
        // Teacher has no units yet - show master units as defaults
        combinedUnits = masterUnits.map((unit) => ({
          ...unit,
          isDefaultUnit: true, // Flag to indicate this is a default unit
        }));
        console.log(
          `Teacher has no units yet, showing ${masterUnits.length} default units from ${MASTER_TEACHER}`,
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
                  teacherLesson.lesson_title === masterLesson.lesson_title,
              ),
          ), // Add master lessons that don't conflict with teacher's lessons
        ];
      } else {
        // Teacher has no units yet - show master lessons as defaults for lesson management
        combinedLessons = masterLessons.map((lesson) => ({
          ...lesson,
          isDefaultLesson: true, // Flag to indicate this is a default lesson
        }));
        console.log(
          `Teacher has no lessons yet, showing ${masterLessons.length} default lessons from ${MASTER_TEACHER}`,
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
      `Found ${allLessonIds.size} unique lesson IDs to populate across all units`,
    );

    // Fetch all required lessons in bulk
    const { ObjectId } = require("mongodb");

    // Helper function to check if a string is a valid MongoDB ObjectId hex string
    const isValidObjectIdHex = (str) => {
      return typeof str === "string" && /^[0-9a-f]{24}$/i.test(str);
    };

    // Helper function to check if a string is a valid numeric ID
    const isNumericId = (str) => {
      return !isNaN(str) && str.trim() !== "";
    };

    // Build query to fetch lessons - handle multiple ID formats
    const objectIdArray = [];
    const numericIdArray = [];

    Array.from(allLessonIds).forEach((id) => {
      if (isValidObjectIdHex(id)) {
        try {
          objectIdArray.push(new ObjectId(id));
        } catch (e) {
          console.log(`⚠️ Failed to convert to ObjectId: ${id}`);
        }
      } else if (isNumericId(id)) {
        numericIdArray.push(parseInt(id, 10));
      }
    });

    console.log(
      `📊 ID Processing: ${objectIdArray.length} ObjectIds, ${numericIdArray.length} numeric IDs`,
    );

    // Fetch lessons with both ID types
    const fullLessonObjects = [];

    // Query by ObjectIds
    if (objectIdArray.length > 0) {
      const objectIdResults = await lessonsCollection
        .find({ _id: { $in: objectIdArray } })
        .toArray();
      fullLessonObjects.push(...objectIdResults);
    }

    // Query by numeric IDs
    if (numericIdArray.length > 0) {
      const numericIdResults = await lessonsCollection
        .find({ _id: { $in: numericIdArray } })
        .toArray();
      fullLessonObjects.push(...numericIdResults);
    }

    console.log(
      `Fetched ${fullLessonObjects.length} full lesson objects from database`,
    );

    // Create a lookup map for quick access - handle both string and ObjectId formats
    const lessonLookup = {};
    fullLessonObjects.forEach((lessonDoc) => {
      // Store by string representation of ID
      const idString = lessonDoc._id.toString();

      // Build complete lesson object from nested lesson data
      const completeLesson = {
        _id: lessonDoc._id,
        teacher: lessonDoc.teacher,
        unit: lessonDoc.unit,
        createdAt: lessonDoc.createdAt,
        updatedAt: lessonDoc.updatedAt,
        // Spread nested lesson object properties
        ...(lessonDoc.lesson || {}),
        // Also include top-level content fields if they exist
        ...(lessonDoc.content && { content: lessonDoc.content }),
        ...(lessonDoc.lesson_conditions && {
          lesson_conditions: lessonDoc.lesson_conditions,
        }),
        ...(lessonDoc.intro_text_blocks && {
          intro_text_blocks: lessonDoc.intro_text_blocks,
        }),
        ...(lessonDoc.learning_objectives && {
          learning_objectives: lessonDoc.learning_objectives,
        }),
      };

      lessonLookup[idString] = completeLesson;
      console.log(
        `🔍 Indexed lesson: ${completeLesson.lesson_title || "Unknown"} with ID ${idString}`,
      );
    });

    console.log(
      `📊 Lesson lookup map created with ${Object.keys(lessonLookup).length} entries`,
    );

    // Replace lesson references with full lesson objects in all units
    combinedUnits.forEach((unit) => {
      if (unit.lessons) {
        unit.lessons = unit.lessons.map((lessonRef) => {
          // Handle both ObjectId and string formats
          const lessonId = lessonRef._id ? lessonRef._id.toString() : null;

          if (lessonId && lessonLookup[lessonId]) {
            console.log(
              `✅ Populated full lesson object for: ${lessonLookup[lessonId].lesson_title}`,
            );
            return lessonLookup[lessonId];
          } else {
            console.log(
              `⚠️ Could not find full lesson object for lesson ID: ${lessonId} (ref: ${lessonRef.lesson_title || "Unknown"})`,
            );
            console.log(
              `   Available IDs in lookup: ${Object.keys(lessonLookup).slice(0, 3).join(", ")}...`,
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
        `  - Lessons count: ${unit.lessons ? unit.lessons.length : 0}`,
      );
      if (unit.lessons && unit.lessons.length > 0) {
        unit.lessons.forEach((lesson, lessonIndex) => {
          console.log(
            `    Lesson ${lessonIndex + 1}: ${lesson.lesson_title || "NO TITLE"}`,
          );
          console.log(`      - Has lesson_blocks: ${!!lesson.lesson_blocks}`);
          console.log(
            `      - lesson_blocks count: ${lesson.lesson_blocks ? lesson.lesson_blocks.length : 0}`,
          );
          console.log(
            `      - Has lesson_conditions: ${!!lesson.lesson_conditions}`,
          );
          console.log(
            `      - lesson_conditions count: ${lesson.lesson_conditions ? lesson.lesson_conditions.length : 0}`,
          );
          console.log(
            `      - Has intro_text_blocks: ${!!lesson.intro_text_blocks}`,
          );
          console.log(
            `      - intro_text_blocks count: ${lesson.intro_text_blocks ? lesson.intro_text_blocks.length : 0}`,
          );
          console.log(
            `      - All lesson keys: ${Object.keys(lesson).join(", ")}`,
          );

          // Log the first few characters of the complete lesson object
          const lessonStr = JSON.stringify(lesson);
          console.log(
            `      - Complete lesson (first 200 chars): ${lessonStr.substring(0, 200)}...`,
          );
        });
      }
    });

    console.log(`Final result for ${teacherName}:`);
    if (teacherName === MASTER_TEACHER) {
      console.log(
        `- ${combinedUnits.length} own units, ${combinedLessons.length} own lessons (master teacher)`,
      );
    } else if (teacherUnits.length > 0) {
      const customUnits = combinedUnits.filter((u) => !u.isDefaultUnit).length;
      const defaultUnits = combinedUnits.filter((u) => u.isDefaultUnit).length;
      console.log(
        `- ${combinedUnits.length} total units (${customUnits} custom + ${defaultUnits} default), ${combinedLessons.length} total lessons (${teacherFlattenedLessons.length} own + ${masterLessons.length} master available)`,
      );
    } else {
      console.log(
        `- ${combinedUnits.length} default units, ${combinedLessons.length} default lessons (from ${MASTER_TEACHER})`,
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
        `Teacher ${teacherName} attempted to edit default unit. Blocking with guidance message.`,
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
        `Master teacher editing default unit - updating master document`,
      );
      // Remove the isDefaultUnit flag before saving
      const cleanUnitData = { ...unitData };
      delete cleanUnitData.isDefaultUnit;

      const updateResult = await teachersCollection.updateOne(
        { name: MASTER_TEACHER, "units.value": cleanUnitData.value },
        { $set: { "units.$": cleanUnitData } },
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
        { $set: { "units.$": unitData } },
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
      { projection: { units: 1, _id: 0 } },
    );

    if (teacherDocument && teacherDocument.units) {
      const existingUnitIndex = teacherDocument.units.findIndex(
        (unit) => unit.value === unitData.value,
      );

      if (existingUnitIndex !== -1) {
        // Replace existing unit (could be default or custom)
        const updateResult = await teachersCollection.updateOne(
          { name: teacherName, "units.value": unitData.value },
          { $set: { "units.$": newUnit } },
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Failed to update existing unit.",
          });
        }

        console.log(
          `Replaced existing unit ${unitData.value} for teacher ${teacherName}`,
        );
      } else {
        // Add new unit
        const addResult = await teachersCollection.updateOne(
          { name: teacherName },
          { $push: { units: newUnit } },
        );

        if (addResult.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Teacher not found.",
          });
        }

        console.log(
          `Added new unit ${unitData.value} for teacher ${teacherName}`,
        );
      }
    } else {
      // Teacher has no units array yet, create it with this unit
      const addResult = await teachersCollection.updateOne(
        { name: teacherName },
        { $set: { units: [newUnit] } },
      );

      if (addResult.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Teacher not found.",
        });
      }

      console.log(
        `Created first unit ${unitData.value} for teacher ${teacherName}`,
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
      `Copying default unit "${unitValue}" for teacher: "${teacherName}"`,
    );

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Get the master teacher's unit
    const masterTeacherDocument = await teachersCollection.findOne(
      { name: MASTER_TEACHER },
      { projection: { units: 1, _id: 0 } },
    );

    if (!masterTeacherDocument || !masterTeacherDocument.units) {
      return res.status(404).json({
        success: false,
        message: "Master teacher content not found.",
      });
    }

    const masterUnit = masterTeacherDocument.units.find(
      (unit) => unit.value === unitValue,
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
      { upsert: true },
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
        { $set: { "units.$.lessons": lessonReferences } },
      );
    }

    console.log(
      `Successfully copied unit "${masterUnit.name}" with ${copiedLessons.length} lessons to teacher ${teacherName}`,
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
      { projection: { units: 1, _id: 0 } },
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
      `Refreshing data: ${units.length} units, ${flattenedLessons.length} lessons`,
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
      },
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
      `Lesson management update for teacher: ${teacherName}, action: ${action}`,
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

app.post("/update-lesson-time", async (req, res) => {
  try {
    const { studentName, lessonId, elapsedTime } = req.body;

    if (!studentName || !lessonId || elapsedTime === undefined) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: studentName, lessonId, elapsedTime",
      });
    }

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");
    const studentProfile = await profilesCollection.findOne({
      memberName: studentName,
    });

    const newElapsedTime = Number(elapsedTime);

    if (studentProfile) {
      const lessonData = studentProfile["Lesson Data"]?.find(
        (ld) => ld.studentName === studentName,
      );
      const existingElapsedTime =
        lessonData?.lessonTimers?.[lessonId]?.elapsedTime || 0;
      const newTotalElapsedTime = existingElapsedTime + newElapsedTime;

      const minutes = Math.floor(newTotalElapsedTime / 60);
      const seconds = Math.floor(newTotalElapsedTime % 60);
      const formattedTime = `${minutes}:${seconds.toString().padStart(2, "0")}`;

      const timerData = {
        elapsedTime: newTotalElapsedTime,
        elapsedMinutes: formattedTime,
        lastUpdated: new Date(),
      };

      if (lessonData) {
        // Update existing lesson data
        await profilesCollection.updateOne(
          { memberName: studentName, "Lesson Data.studentName": studentName },
          { $set: { [`Lesson Data.$.lessonTimers.${lessonId}`]: timerData } },
        );
      } else {
        // Push new lesson data object
        await profilesCollection.updateOne(
          { memberName: studentName },
          {
            $push: {
              "Lesson Data": {
                studentName,
                lessonTimers: { [lessonId]: timerData },
              },
            },
          },
        );
      }

      res.status(200).json({
        success: true,
        message: "Lesson time updated successfully.",
        totalElapsedTime: newTotalElapsedTime,
        formattedTime: formattedTime,
      });
    } else {
      // Create new student profile
      const minutes = Math.floor(newElapsedTime / 60);
      const seconds = Math.floor(newElapsedTime % 60);
      const formattedTime = `${minutes}:${seconds.toString().padStart(2, "0")}`;
      const timerData = {
        elapsedTime: newElapsedTime,
        elapsedMinutes: formattedTime,
        lastUpdated: new Date(),
      };

      await profilesCollection.insertOne({
        memberName: studentName,
        "Lesson Data": [
          {
            studentName: studentName,
            lessonTimers: { [lessonId]: timerData },
          },
        ],
      });

      res.status(201).json({
        success: true,
        message: "New student profile created and lesson time saved.",
        totalElapsedTime: newElapsedTime,
        formattedTime: formattedTime,
      });
    }
  } catch (error) {
    console.error("Error updating lesson time:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update lesson time." });
  }
});

app.get("/api/timers", async (req, res) => {
  try {
    const { studentId, lessonId } = req.query;

    if (!studentId || !lessonId) {
      return res.status(400).json({
        success: false,
        message: "Student ID and Lesson ID are required.",
      });
    }

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    const studentProfile = await profilesCollection.findOne({
      memberName: studentId,
    });

    if (!studentProfile) {
      // If no profile, it's a new student for timer purposes.
      console.log(
        `No profile found for student ${studentId}. Returning default timer.`,
      );
      return res.status(200).json({
        success: true,
        elapsedTime: 0,
        formattedTime: "0:00",
        message: "No existing timer found, starting new one.",
      });
    }

    // Find lesson data for the student
    const lessonData = studentProfile["Lesson Data"]?.find(
      (ld) => ld.studentName === studentId,
    );

    const timerData = lessonData?.lessonTimers?.[lessonId];

    if (!timerData) {
      console.log(
        `No timer found for lesson ${lessonId} for student ${studentId}. Returning default timer.`,
      );
      return res.status(200).json({
        success: true,
        elapsedTime: 0,
        formattedTime: "0:00",
        message: "No existing timer found, starting new one.",
      });
    }

    console.log(
      `Retrieved lesson timer for ${studentId}, lesson ${lessonId}: ${timerData.elapsedTime} seconds`,
    );

    res.status(200).json({
      success: true,
      studentId: studentId,
      lessonId: lessonId,
      elapsedTime: timerData.elapsedTime,
      formattedTime: timerData.elapsedMinutes,
      lastUpdated: timerData.lastUpdated,
    });
  } catch (error) {
    console.error("Could not fetch lesson timer:", error);
    res.status(500).json({
      success: false,
      message: "Could not fetch lesson timer.",
    });
  }
});

// New endpoint to get existing lesson time for resuming timer
app.get("/get-lesson-time/:studentName/:lessonId", async (req, res) => {
  try {
    const { studentName, lessonId } = req.params;

    if (!studentName || !lessonId) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: studentName, lessonId",
      });
    }

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Find the student's profile
    const studentProfile = await profilesCollection.findOne({
      memberName: studentName,
    });

    if (!studentProfile) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found.",
      });
    }

    // Get existing time for this lesson
    const lessonData = studentProfile["Lesson Data"]?.find(
      (ld) => ld.studentName === studentName,
    );

    const existingElapsedTime =
      lessonData?.lessonTimers?.[lessonId]?.elapsedTime || 0;

    const formattedTime =
      lessonData?.lessonTimers?.[lessonId]?.elapsedMinutes || "0:00";
    const lastUpdated = lessonData?.lessonTimers?.[lessonId]?.lastUpdated;

    console.log(
      `Retrieved lesson time for ${studentName}, lesson ${lessonId}: ${existingElapsedTime} seconds (${formattedTime})`,
    );

    res.status(200).json({
      success: true,
      studentName: studentName,
      lessonId: lessonId,
      elapsedTime: existingElapsedTime,
      formattedTime: formattedTime,
      lastUpdated: lastUpdated,
      message: "Lesson time retrieved successfully.",
    });
  } catch (error) {
    console.error("Error retrieving lesson time:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve lesson time.",
    });
  }
});

// GET endpoint to fetch saved condition states for a lesson
app.get("/api/lesson-condition-state", async (req, res) => {
  try {
    const { studentId, lessonId } = req.query;

    if (!studentId || !lessonId) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: studentId, lessonId",
      });
    }

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Find the student's profile
    const studentProfile = await profilesCollection.findOne({
      memberName: studentId,
    });

    if (!studentProfile) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found.",
      });
    }

    // Get lesson data for this student
    const lessonData = studentProfile["Lesson Data"]?.find(
      (ld) => ld.studentName === studentId,
    );

    // Get condition states for this specific lesson
    const conditionStates = lessonData?.conditionStates?.[lessonId];

    if (!conditionStates) {
      return res.status(404).json({
        success: false,
        message: `No saved condition states found for lesson ${lessonId}.`,
      });
    }

    console.log(
      `Retrieved condition states for ${studentId}, lesson ${lessonId}:`,
      conditionStates,
    );

    res.status(200).json({
      success: true,
      studentId: studentId,
      lessonId: lessonId,
      conditions: conditionStates,
    });
  } catch (error) {
    console.error("Error fetching condition states:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch condition states.",
    });
  }
});

// POST endpoint to save condition states for a lesson
app.post("/api/lesson-condition-state", async (req, res) => {
  try {
    const { studentId, lessonId, conditions } = req.body;

    if (!studentId || !lessonId || !conditions) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: studentId, lessonId, conditions",
      });
    }

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    const studentProfile = await profilesCollection.findOne({
      memberName: studentId,
    });

    const conditionStatesData = {
      [lessonId]: conditions,
      savedAt: new Date(),
    };

    if (studentProfile) {
      const lessonDataForStudent = studentProfile["Lesson Data"]?.find(
        (d) => d.studentName === studentId,
      );

      if (lessonDataForStudent) {
        // Update existing Lesson Data
        await profilesCollection.updateOne(
          { memberName: studentId, "Lesson Data.studentName": studentId },
          {
            $set: {
              "Lesson Data.$.conditionStates": {
                ...lessonDataForStudent.conditionStates,
                ...conditionStatesData,
              },
              "Lesson Data.$.lastConditionUpdate": new Date(),
            },
          },
        );
      } else {
        // Student exists, but no Lesson Data object for them, so push one.
        await profilesCollection.updateOne(
          { memberName: studentId },
          {
            $push: {
              "Lesson Data": {
                studentName: studentId,
                conditionStates: conditionStatesData,
                lastConditionUpdate: new Date(),
              },
            },
          },
        );
      }
    } else {
      // Student does not exist, so create them with Lesson Data.
      await profilesCollection.insertOne({
        memberName: studentId,
        "Lesson Data": [
          {
            studentName: studentId,
            conditionStates: conditionStatesData,
            lastConditionUpdate: new Date(),
          },
        ],
      });
    }

    console.log(
      `Condition states saved for ${studentId}, lesson ${lessonId}:`,
      JSON.stringify(conditions, null, 2),
    );

    res.status(200).json({
      success: true,
      message: `Condition states saved successfully for lesson ${lessonId}`,
      studentId: studentId,
      lessonId: lessonId,
    });
  } catch (error) {
    console.error("Error saving condition states:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save condition states.",
    });
  }
});

app.post("/api/sdsm/session", async (req, res) => {
  try {
    const {
      studentName,
      activeLessons,
      completedLessons,
      lessonTimers,
      timestamp,
    } = req.body;
    if (!studentName) {
      return res.status(400).json({
        success: false,
        message: "Missing studentName in request.",
      });
    }

    console.log("Received student session data for:", studentName);
    console.log("Session Data:", req.body);

    const profilesCollection = client
      .db("TrinityCapital")
      .collection("User Profiles");

    // Prepare session data object
    const sessionData = {
      studentName: studentName,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    };

    // Add active lessons if provided
    if (activeLessons && Array.isArray(activeLessons)) {
      sessionData.activeLessons = activeLessons;
    }

    // Add lesson timers if provided (though these are now saved separately)
    if (lessonTimers && typeof lessonTimers === "object") {
      sessionData.lessonTimers = lessonTimers;
    }

    // Handle completed lessons with snapshots
    console.log("🔍 DEBUG: Checking completedLessons parameter...");
    console.log("completedLessons type:", typeof completedLessons);
    console.log("completedLessons is array?", Array.isArray(completedLessons));
    console.log(
      "completedLessons value:",
      JSON.stringify(completedLessons, null, 2),
    );

    if (
      completedLessons &&
      Array.isArray(completedLessons) &&
      completedLessons.length > 0
    ) {
      console.log(
        `✅ Processing ${completedLessons.length} completed lessons for ${studentName}`,
      );

      // Store completed lessons in the User Profiles document as an array
      const completionRecords = completedLessons.map((completedLesson) => ({
        lessonId: completedLesson.lessonId,
        lessonTitle: completedLesson.lessonTitle,
        completedAt: new Date(completedLesson.completedAt),
        snapshot: completedLesson.snapshot,
        sessionTimestamp: sessionData.timestamp,
      }));

      console.log(
        "📝 Attempting to save completion records:",
        JSON.stringify(completionRecords, null, 2),
      );

      // ⚠️ SNAPSHOT VALIDATION - Check if snapshot contains data
      completionRecords.forEach((record, idx) => {
        console.log(
          `\n🔍 SNAPSHOT ANALYSIS FOR LESSON ${idx + 1}: "${record.lessonTitle}"`,
        );
        console.log("================================================");

        if (!record.snapshot) {
          console.log("❌ ERROR: Snapshot is missing or null!");
          return;
        }

        const snapshot = record.snapshot;
        console.log(`Snapshot type: ${typeof snapshot}`);
        console.log(`Snapshot keys: ${Object.keys(snapshot).join(", ")}`);

        // Check for bills and paychecks specifically
        if (snapshot.bills !== undefined) {
          console.log(`✅ Found 'bills' property`);
          console.log(`   Type: ${typeof snapshot.bills}`);
          console.log(`   Is array: ${Array.isArray(snapshot.bills)}`);
          console.log(
            `   Length: ${Array.isArray(snapshot.bills) ? snapshot.bills.length : "N/A"}`,
          );
          if (Array.isArray(snapshot.bills) && snapshot.bills.length > 0) {
            console.log(
              `   Content: ${JSON.stringify(snapshot.bills, null, 2)}`,
            );
          } else {
            console.log(`   ⚠️ WARNING: bills array is EMPTY`);
          }
        } else {
          console.log(`❌ ERROR: 'bills' property NOT FOUND in snapshot!`);
        }

        if (snapshot.paychecks !== undefined) {
          console.log(`✅ Found 'paychecks' property`);
          console.log(`   Type: ${typeof snapshot.paychecks}`);
          console.log(`   Is array: ${Array.isArray(snapshot.paychecks)}`);
          console.log(
            `   Length: ${Array.isArray(snapshot.paychecks) ? snapshot.paychecks.length : "N/A"}`,
          );
          if (
            Array.isArray(snapshot.paychecks) &&
            snapshot.paychecks.length > 0
          ) {
            console.log(
              `   Content: ${JSON.stringify(snapshot.paychecks, null, 2)}`,
            );
          } else {
            console.log(`   ⚠️ WARNING: paychecks array is EMPTY`);
          }
        } else {
          console.log(`❌ ERROR: 'paychecks' property NOT FOUND in snapshot!`);
        }

        // Show all properties in the snapshot for debugging
        console.log(`\nAll snapshot properties:`);
        Object.entries(snapshot).forEach(([key, value]) => {
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
          ) {
            console.log(
              `  - ${key}: [object] with keys ${Object.keys(value).join(", ")}`,
            );
          } else if (Array.isArray(value)) {
            console.log(`  - ${key}: [array] length ${value.length}`);
          } else {
            console.log(
              `  - ${key}: ${typeof value} = ${String(value).substring(0, 50)}`,
            );
          }
        });

        console.log("================================================\n");
      });

      sessionData.completedLessonsCount = completedLessons.length;
      // Add completed lessons to sessionData to be saved in one operation
      sessionData.completedLessons = completionRecords;

      console.log(
        `✅ Prepared ${completionRecords.length} completion snapshots to be saved with session data`,
      );
    }

    // --- New logic for lesson data consolidation ---
    try {
      const studentProfile = await profilesCollection.findOne({
        memberName: studentName,
      });

      const updateOps = {
        $set: { lastSessionUpdate: sessionData.timestamp },
        $push: {},
      };

      // Handle root-level completedLessons
      if (
        sessionData.completedLessons &&
        sessionData.completedLessons.length > 0
      ) {
        const rootExistingIds = new Set(
          studentProfile?.completedLessons?.map((l) => l.lessonId) || [],
        );
        const newRootCompletionRecords = sessionData.completedLessons.filter(
          (l) => !rootExistingIds.has(l.lessonId),
        );
        if (newRootCompletionRecords.length > 0) {
          updateOps.$push.completedLessons = {
            $each: newRootCompletionRecords,
          };
        }
      }

      const lessonDataForStudent = studentProfile?.["Lesson Data"]?.find(
        (d) => d.studentName === studentName,
      );

      if (lessonDataForStudent) {
        // --- UPDATE EXISTING LESSON DATA ---
        updateOps.$set[`Lesson Data.$[elem].timestamp`] = sessionData.timestamp;
        if (sessionData.activeLessons) {
          updateOps.$set[`Lesson Data.$[elem].activeLessons`] =
            sessionData.activeLessons;
        }
        if (sessionData.lessonTimers) {
          for (const lessonId in sessionData.lessonTimers) {
            updateOps.$set[`Lesson Data.$[elem].lessonTimers.${lessonId}`] =
              sessionData.lessonTimers[lessonId];
          }
        }

        if (
          sessionData.completedLessons &&
          sessionData.completedLessons.length > 0
        ) {
          const nestedExistingIds = new Set(
            lessonDataForStudent.completedLessons?.map((l) => l.lessonId) || [],
          );
          const newNestedCompletionRecords =
            sessionData.completedLessons.filter(
              (l) => !nestedExistingIds.has(l.lessonId),
            );
          if (newNestedCompletionRecords.length > 0) {
            updateOps.$push[`Lesson Data.$[elem].completedLessons`] = {
              $each: newNestedCompletionRecords,
            };
          }
        }

        if (Object.keys(updateOps.$push).length === 0) delete updateOps.$push;

        await profilesCollection.updateOne(
          { memberName: studentName },
          updateOps,
          { arrayFilters: [{ "elem.studentName": studentName }] },
        );
      } else {
        // --- PUSH NEW LESSON DATA ---
        if (!updateOps.$push) updateOps.$push = {};
        updateOps.$push["Lesson Data"] = sessionData;
        await profilesCollection.updateOne(
          { memberName: studentName },
          updateOps,
          { upsert: true },
        );
      }

      console.log(`Session data stored for ${studentName}`);
      res.status(200).json({
        success: true,
        message: "Session data stored successfully",
        completedLessonsStored: completedLessons ? completedLessons.length : 0,
      });
    } catch (error) {
      console.error("Error processing SDSM session data:", error);
      res
        .status(500)
        .json({ success: false, message: "Failed to store session data." });
    }
    // --- End of new logic ---
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
      { projection: { units: 1, _id: 0 } },
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
      (unit) => unit.assigned_to_period === classPeriod,
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
      `Found unit "${assignedUnit.name}" with ${fullLessons.length} lessons for period ${classPeriod}`,
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
      { projection: { units: 1, _id: 0 } },
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
      `Returning ${masterUnits.length} units and ${masterLessons.length} lessons from master teacher`,
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
    "Content-Type, Authorization, Origin, X-Requested-With, Accept",
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
      "*************************************************************",
    );
    console.log(
      "************ LESSON SERVER: GET-LESSONS-BY-IDS **************",
    );
    console.log(
      "*************************************************************",
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
        "*************************************************************\n\n",
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
        JSON.stringify(studentProfile, null, 2),
      );
    }
    console.log(
      `[get-lessons-by-ids] Requesting ${lessonIds.length} lessons by ID:`,
      lessonIds,
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
        2,
      ),
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
            `  ➕ Converted to ObjectId: ${objId} and added to objectIds array`,
          );
        } catch (e) {
          console.log(
            `  ❌ Could not convert numeric ID ${id} to ObjectId: ${e.message}`,
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
            `  ➕ Converted to number: ${numId} and added to numericIds array`,
          );
        } else {
          console.log(
            `  ℹ️ ID "${id}" doesn't look like a number, not converting`,
          );
        }

        // Try as ObjectId
        try {
          const objId = new ObjectId(id);
          objectIds.push(objId);
          console.log(
            `  ➕ Converted to ObjectId: ${objId} and added to objectIds array`,
          );
        } catch (e) {
          console.log(
            `  ❌ Could not convert string ID "${id}" to ObjectId: ${e.message}`,
          );
        }
      } else {
        console.log(`  ⚠️ Unexpected ID type: ${typeof id}, value: ${id}`);
      }
    });

    console.log("\n📋 ID PROCESSING SUMMARY 📋");
    console.log("==========================");
    console.log(
      `✅ Processed IDs: ${objectIds.length} ObjectIDs, ${stringIds.length} strings, ${numericIds.length} numbers`,
    );
    if (objectIds.length > 0) {
      console.log(
        `📦 ObjectIDs: ${objectIds.map((id) => id.toString()).join(", ")}`,
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
        `Query: db.Lessons.find({ _id: { $in: [${objectIds.map((id) => id.toString()).join(", ")}] } })`,
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
              `   - Lesson title: ${firstLesson.lesson.lesson_title || "Not available"}`,
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
        `Query: db.Lessons.find({ "lesson.lesson_id": { $in: ["${stringIds.join('", "')}"] } })`,
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
          `✅ Found ${stringLessons1.length} lessons by lesson.lesson_id field`,
        );

        if (stringLessons1.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons1[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson.lesson_id: ${firstLesson.lesson?.lesson_id || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error in lesson.lesson_id query: ${error.message}`);
      }

      console.log("\n📌 QUERY #3: Using string IDs for lessonId field");
      console.log(
        `Query: db.Lessons.find({ "lessonId": { $in: ["${stringIds.join('", "')}"] } })`,
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
          `✅ Found ${stringLessons2.length} lessons by lessonId field`,
        );

        if (stringLessons2.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons2[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lessonId: ${firstLesson.lessonId || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error in lessonId query: ${error.message}`);
      }

      console.log("\n📌 QUERY #4: Using string IDs for lesson_id field");
      console.log(
        `Query: db.Lessons.find({ "lesson_id": { $in: ["${stringIds.join('", "')}"] } })`,
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
          `✅ Found ${stringLessons3.length} lessons by lesson_id field`,
        );

        if (stringLessons3.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = stringLessons3[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson_id: ${firstLesson.lesson_id || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error in lesson_id query: ${error.message}`);
      }
    }

    // Try to find lessons using numeric IDs for various ID fields
    if (numericIds.length > 0) {
      console.log(
        "\n📌 QUERY #5: Using numeric IDs for lesson.lesson_id field",
      );
      console.log(
        `Query: db.Lessons.find({ "lesson.lesson_id": { $in: [${numericIds.join(", ")}] } })`,
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
          `✅ Found ${numericLessons1.length} lessons by lesson.lesson_id field as number`,
        );

        if (numericLessons1.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons1[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson.lesson_id: ${firstLesson.lesson?.lesson_id || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(
          `❌ Error in numeric lesson.lesson_id query: ${error.message}`,
        );
      }

      console.log("\n📌 QUERY #6: Using numeric IDs for lessonId field");
      console.log(
        `Query: db.Lessons.find({ "lessonId": { $in: [${numericIds.join(", ")}] } })`,
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
          `✅ Found ${numericLessons2.length} lessons by lessonId field as number`,
        );

        if (numericLessons2.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons2[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lessonId: ${firstLesson.lessonId || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error in numeric lessonId query: ${error.message}`);
      }

      console.log("\n📌 QUERY #7: Using numeric IDs for lesson_id field");
      console.log(
        `Query: db.Lessons.find({ "lesson_id": { $in: [${numericIds.join(", ")}] } })`,
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
          `✅ Found ${numericLessons3.length} lessons by lesson_id field as number`,
        );

        if (numericLessons3.length > 0) {
          console.log("📄 First match details:");
          const firstLesson = numericLessons3[0];
          console.log(`   - _id: ${firstLesson._id}`);
          console.log(
            `   - lesson_id: ${firstLesson.lesson_id || "Not available"}`,
          );
        }
      } catch (error) {
        console.error(`❌ Error in numeric lesson_id query: ${error.message}`);
      }

      // Additional query: Try _id field directly with numbers
      console.log("\n📌 QUERY #8: Using numeric IDs for _id field directly");
      console.log(
        `Query: db.Lessons.find({ "_id": { $in: [${numericIds.join(", ")}] } })`,
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
          `✅ Found ${numericLessons4.length} lessons by _id field as number`,
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
      `Total lessons found before deduplication: ${lessonDocuments.length}`,
    );

    if (lessonDocuments.length > 0) {
      console.log("IDs before deduplication:");
      lessonDocuments.forEach((doc, index) => {
        console.log(`  ${index + 1}. _id: ${doc._id}, type: ${typeof doc._id}`);
      });
    }

    const uniqueLessons = lessonDocuments.filter((lesson, index, self) => {
      const firstIndex = self.findIndex(
        (l) => l._id.toString() === lesson._id.toString(),
      );
      const isDuplicate = index !== firstIndex;
      if (isDuplicate) {
        console.log(
          `  ↪️ Duplicate found: ${lesson._id} (index ${index} is duplicate of index ${firstIndex})`,
        );
      }
      return !isDuplicate;
    });

    console.log(
      `✅ After deduplication: ${uniqueLessons.length} unique lessons (removed ${lessonDocuments.length - uniqueLessons.length} duplicates)`,
    );

    // Transform lessons to the format expected by the lesson engine
    console.log("\n🔄 LESSON TRANSFORMATION 🔄");
    console.log("==========================");

    const lessons = uniqueLessons.map((doc, index) => {
      // Log the document structure to help with debugging
      console.log(
        `\n📝 Processing lesson ${index + 1}/${uniqueLessons.length} with ID ${doc._id}:`,
      );
      console.log(`  - Document fields: ${Object.keys(doc).join(", ")}`);

      if (doc.lesson) {
        console.log(
          `  - Has 'lesson' property with fields: ${Object.keys(doc.lesson).join(", ")}`,
        );
      } else {
        console.log(
          `  - No 'lesson' property found, using top-level properties`,
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
          `  - '${propName}' not found, using default: ${defaultValue}`,
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
        `  ✅ Transformed lesson: ID=${transformedLesson._id}, Title=${transformedLesson.lesson_title || "(no title)"}`,
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
          `  - First block type: ${lessonBlocks[0].type || "unknown"}`,
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
      "RESPONSE SENT TO CLIENT: success=true, foundCount=" + lessons.length,
    );
    console.log(
      "*************************************************************\n\n",
    );
  } catch (error) {
    console.error("Failed to fetch lessons by IDs:", error);
    console.log("ERROR:", error.message);
    console.log(
      "*************************************************************\n\n",
    );
    res.status(500).json({
      success: false,
      message: "Failed to fetch lessons: " + error.message,
    });
  }
});

// Fix endpoint to repair corrupted lesson structure
// Converts nested lesson object to flat structure at top level
app.post("/fix-lesson-structure/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;

    if (!lessonId) {
      return res.status(400).json({
        success: false,
        message: "Missing lessonId parameter",
      });
    }

    console.log(`\n========== FIXING LESSON STRUCTURE ==========`);
    console.log(`Lesson ID: ${lessonId}`);

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Try to find the lesson by numeric ID
    const numericId = parseInt(lessonId, 10);
    let lesson = null;

    if (!isNaN(numericId)) {
      lesson = await lessonsCollection.findOne({ _id: numericId });
    }

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: `Lesson ${lessonId} not found`,
      });
    }

    console.log("Found lesson with structure:", Object.keys(lesson));

    // Check if lesson has nested structure (data inside lesson.lesson object)
    if (lesson.lesson && typeof lesson.lesson === "object") {
      console.log(
        "✅ Detected nested lesson structure - converting to flat structure",
      );

      // Extract all data from nested lesson object
      const nestedData = lesson.lesson;

      // Build the flattened lesson document with all data at top level
      const flattenedLesson = {
        _id: lesson._id,
        lesson_title: nestedData.lesson_title || lesson.lesson_title || "",
        lesson_description:
          nestedData.lesson_description || lesson.lesson_description || "",
        content: nestedData.content || lesson.content || [],
        lesson_blocks: nestedData.lesson_blocks || lesson.lesson_blocks || [],
        intro_text_blocks:
          nestedData.intro_text_blocks || lesson.intro_text_blocks || [],
        learning_objectives:
          nestedData.learning_objectives || lesson.learning_objectives || [],
        lesson_conditions:
          nestedData.lesson_conditions || lesson.lesson_conditions || [],
        required_actions:
          nestedData.required_actions || lesson.required_actions || [],
        success_metrics:
          nestedData.success_metrics || lesson.success_metrics || {},
        teks_standards:
          nestedData.teks_standards || lesson.teks_standards || [],
        day: nestedData.day || lesson.day || null,
        status: nestedData.status || lesson.status || "active",
        difficulty_level:
          nestedData.difficulty_level || lesson.difficulty_level || null,
        estimated_duration:
          nestedData.estimated_duration || lesson.estimated_duration || null,
        dallas_fed_aligned:
          nestedData.dallas_fed_aligned !== undefined
            ? nestedData.dallas_fed_aligned
            : lesson.dallas_fed_aligned || null,
        condition_alignment:
          nestedData.condition_alignment || lesson.condition_alignment || null,
        structure_cleaned:
          nestedData.structure_cleaned || lesson.structure_cleaned || null,
        teacher: nestedData.teacher || lesson.teacher,
        unit: nestedData.unit || lesson.unit,
        creator_email: nestedData.creator_email || lesson.creator_email,
        creator_username:
          nestedData.creator_username || lesson.creator_username,
        createdAt: nestedData.createdAt || lesson.createdAt,
        updatedAt: nestedData.updatedAt || lesson.updatedAt || new Date(),
      };

      // Clean lesson_conditions array - remove any metadata that ended up inside it
      flattenedLesson.lesson_conditions = flattenedLesson.lesson_conditions.map(
        (condition) => {
          // Extract only condition-related fields, remove metadata
          return {
            condition_type: condition.condition_type,
            condition_value: condition.condition_value,
            value: condition.value,
            action_type: condition.action_type,
            action_details: condition.action_details,
            action: condition.action,
          };
        },
      );

      console.log("\n📝 Flattened lesson structure:");
      console.log(`  - lesson_title: ${flattenedLesson.lesson_title}`);
      console.log(
        `  - lesson_description: ${flattenedLesson.lesson_description}`,
      );
      console.log(`  - content items: ${flattenedLesson.content.length}`);
      console.log(`  - lesson_blocks: ${flattenedLesson.lesson_blocks.length}`);
      console.log(
        `  - lesson_conditions: ${flattenedLesson.lesson_conditions.length}`,
      );
      console.log(
        `  - learning_objectives: ${flattenedLesson.learning_objectives.length}`,
      );
      console.log(
        `  - required_actions: ${flattenedLesson.required_actions.length}`,
      );
      console.log(`  - teacher: ${flattenedLesson.teacher}`);
      console.log(`  - status: ${flattenedLesson.status}`);

      // Update the lesson in the database with flattened structure
      const updateResult = await lessonsCollection.updateOne(
        { _id: lesson._id },
        { $set: flattenedLesson },
      );

      if (updateResult.modifiedCount === 0) {
        console.warn("⚠️ No documents were modified");
      }

      console.log(
        `✅ FIXED: Lesson structure corrected and saved to database\n`,
      );

      res.status(200).json({
        success: true,
        message: `Lesson ${lessonId} structure fixed successfully`,
        details: {
          lessonId: lesson._id,
          lessonTitle: flattenedLesson.lesson_title,
          contentItems: flattenedLesson.content.length,
          lessonBlocks: flattenedLesson.lesson_blocks.length,
          conditions: flattenedLesson.lesson_conditions.length,
          learningObjectives: flattenedLesson.learning_objectives.length,
        },
      });
    } else {
      // Lesson already has correct flat structure
      console.log(
        "✅ Lesson already has correct flat structure - no fix needed",
      );

      res.status(200).json({
        success: true,
        message: `Lesson ${lessonId} already has correct structure`,
        isAlreadyFlat: true,
      });
    }
  } catch (error) {
    console.error("Failed to fix lesson structure:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fix lesson structure: " + error.message,
    });
  }
});

// Fix lesson conditions: populate condition_value from value field
app.post("/fix-lesson-conditions/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;

    console.log(`\n--- Fix Lesson Conditions: ${lessonId} ---`);

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Parse lessonId (could be numeric or ObjectId)
    let numericId = parseInt(lessonId, 10);
    let query = {};

    if (!isNaN(numericId)) {
      query = { _id: numericId };
    } else {
      const { ObjectId } = require("mongodb");
      try {
        query = { _id: new ObjectId(lessonId) };
      } catch (e) {
        query = { _id: lessonId };
      }
    }

    console.log(`Query: ${JSON.stringify(query)}`);

    // Fetch the lesson
    const lesson = await lessonsCollection.findOne(query);

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: `Lesson not found: ${lessonId}`,
      });
    }

    console.log(
      `Found lesson: ${lesson.lesson_title || lesson.lesson?.lesson_title || "Unknown"}`,
    );

    // Check if conditions need fixing
    const conditions = lesson.lesson_conditions || [];

    if (conditions.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Lesson has no conditions",
        conditionsCounted: 0,
        conditionsFixed: 0,
      });
    }

    console.log(`📋 Processing ${conditions.length} conditions...`);

    let conditionsFixed = 0;

    // Fix each condition by copying value to condition_value if condition_value is null
    const fixedConditions = conditions.map((condition, index) => {
      console.log(`\n  Condition ${index + 1}: ${condition.condition_type}`);
      console.log(`    - condition_value: ${condition.condition_value}`);
      console.log(`    - value: ${condition.value}`);

      if (condition.condition_value === null && condition.value !== undefined) {
        console.log(
          `    ✅ FIXING: Setting condition_value to ${condition.value}`,
        );
        conditionsFixed++;
        return {
          ...condition,
          condition_value: condition.value,
        };
      } else if (condition.condition_value !== null) {
        console.log(
          `    ℹ️  SKIP: condition_value already set to ${condition.condition_value}`,
        );
      } else {
        console.log(`    ⚠️  WARN: No value to fix`);
      }

      return condition;
    });

    if (conditionsFixed === 0) {
      console.log("\n✅ No conditions needed fixing");
      return res.status(200).json({
        success: true,
        message: "All conditions already have condition_value populated",
        conditionsCounted: conditions.length,
        conditionsFixed: 0,
      });
    }

    // Update the lesson with fixed conditions
    console.log(
      `\n💾 Saving ${conditionsFixed} fixed conditions to database...`,
    );

    const updateResult = await lessonsCollection.updateOne(query, {
      $set: { lesson_conditions: fixedConditions },
    });

    if (updateResult.matchedCount === 0) {
      return res.status(500).json({
        success: false,
        message: "Failed to update lesson",
      });
    }

    console.log(`✅ FIXED: ${conditionsFixed} conditions updated and saved`);

    res.status(200).json({
      success: true,
      message: `Fixed ${conditionsFixed} condition values for lesson`,
      lessonId: lesson._id,
      lessonTitle: lesson.lesson_title || lesson.lesson?.lesson_title,
      conditionsCounted: conditions.length,
      conditionsFixed: conditionsFixed,
    });
  } catch (error) {
    console.error("Failed to fix lesson conditions:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fix lesson conditions: " + error.message,
    });
  }
});

// Restore lesson to clean proper structure (remove duplicates and unnecessary fields)
app.post("/restore-lesson/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;

    console.log(`\n--- Restore Lesson Structure: ${lessonId} ---`);

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Parse lessonId (could be numeric or ObjectId)
    let numericId = parseInt(lessonId, 10);
    let query = {};

    if (!isNaN(numericId)) {
      query = { _id: numericId };
    } else {
      const { ObjectId } = require("mongodb");
      try {
        query = { _id: new ObjectId(lessonId) };
      } catch (e) {
        query = { _id: lessonId };
      }
    }

    // Fetch the lesson
    const lesson = await lessonsCollection.findOne(query);

    if (!lesson) {
      return res.status(404).json({
        success: false,
        message: `Lesson not found: ${lessonId}`,
      });
    }

    const lessonData = lesson.lesson || lesson;
    const lessonTitle = lessonData.lesson_title || "Unknown";

    console.log(`Found lesson: ${lessonTitle}`);

    // Build clean lesson object with only necessary fields
    const cleanLesson = {
      _id: lesson._id,
      lesson: {
        lesson_title: lessonData.lesson_title || "",
        lesson_description: lessonData.lesson_description || "",
        unit: lessonData.unit || "",
        content: lessonData.content || [],
        learning_objectives: lessonData.learning_objectives || [],
        creator_email: lessonData.creator_email || "admin@trinity-capital.net",
        creator_username: lessonData.creator_username || "adminTC",
        teacher: lessonData.teacher || "admin@trinity-capital.net",
        createdAt: lessonData.createdAt || new Date(),
        dallas_fed_aligned:
          typeof lessonData.dallas_fed_aligned === "boolean"
            ? lessonData.dallas_fed_aligned
            : true,
        teks_standards: lessonData.teks_standards || [],
        day: lessonData.day || null,
        status: lessonData.status || "active",
        difficulty_level: lessonData.difficulty_level || null,
        estimated_duration: lessonData.estimated_duration || null,
        condition_alignment:
          lessonData.condition_alignment || "teacher_dashboard_compatible",
        structure_cleaned: true,
        updatedAt: new Date(),
      },
      teacher: lessonData.teacher || "admin@trinity-capital.net",
      unit: lessonData.unit || "",
      createdAt: lessonData.createdAt || new Date(),
    };

    // Clean lesson_conditions - remove duplicates, remove null action_type/action_details, keep only essential fields
    const conditions = lessonData.lesson_conditions || [];
    const cleanedConditions = [];
    const seenConditions = new Set();

    for (const cond of conditions) {
      if (!cond.condition_type) continue;

      // Create a unique key to detect duplicates
      const condKey = `${cond.condition_type}_${cond.condition_value || cond.value}`;
      if (seenConditions.has(condKey)) {
        console.log(`  ⏭️ Skipping duplicate condition: ${condKey}`);
        continue;
      }
      seenConditions.add(condKey);

      // Clean condition object - keep only essential fields
      const cleanCond = {
        condition_type: cond.condition_type,
        condition_value:
          cond.condition_value !== null ? cond.condition_value : cond.value,
        action_type: cond.action_type || null,
      };

      // Add action_details only if action_type is set and details exist
      if (cond.action_type && cond.action_details) {
        cleanCond.action_details = cond.action_details;
      }

      // Add action if it has meaningful properties
      if (cond.action && Object.keys(cond.action).length > 0) {
        cleanCond.action = cond.action;
      }

      cleanedConditions.push(cleanCond);
      console.log(
        `  ✅ Cleaned condition: ${cond.condition_type} = ${cleanCond.condition_value}`,
      );
    }

    cleanLesson.lesson.lesson_conditions = cleanedConditions;

    // Add required_actions if not present
    if (!lesson.required_actions || lesson.required_actions.length === 0) {
      cleanLesson.lesson.required_actions = cleanedConditions.map(
        (c) => c.condition_type,
      );
      console.log(`  ✅ Generated required_actions from conditions`);
    } else {
      cleanLesson.lesson.required_actions = lesson.required_actions;
    }

    // Add success_metrics with defaults
    cleanLesson.lesson.success_metrics = {
      minimum_conditions_met: Math.max(
        Math.floor(cleanedConditions.length * 0.66),
        2,
      ),
      time_limit_minutes: 30,
      engagement_score_minimum: 60,
      updated_at: new Date(),
    };

    console.log(`\n✅ Cleaned lesson structure:`);
    console.log(
      `   - Conditions: ${cleanedConditions.length} (removed duplicates)`,
    );
    console.log(
      `   - Required actions: ${cleanLesson.lesson.required_actions.length}`,
    );
    console.log(`   - Content items: ${cleanLesson.lesson.content.length}`);

    // Replace the entire lesson document
    const updateResult = await lessonsCollection.replaceOne(query, cleanLesson);

    if (updateResult.matchedCount === 0) {
      return res.status(500).json({
        success: false,
        message: "Failed to update lesson",
      });
    }

    console.log(`✅ RESTORED: Lesson structure cleaned and saved`);

    res.status(200).json({
      success: true,
      message: `Lesson ${lessonTitle} restored to clean structure`,
      lessonId: lesson._id,
      lessonTitle: lessonTitle,
      conditionsCleaned: cleanedConditions.length,
      duplicatesRemoved: conditions.length - cleanedConditions.length,
    });
  } catch (error) {
    console.error("Failed to restore lesson:", error);
    res.status(500).json({
      success: false,
      message: "Failed to restore lesson: " + error.message,
    });
  }
});

// Add TEKS-aligned content blocks to a lesson
app.post("/add-teks-blocks/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Parse lesson ID
    let query = {};
    const numericId = parseInt(lessonId, 10);

    if (!isNaN(numericId)) {
      query = { _id: numericId };
    } else {
      query = { _id: lessonId };
    }

    // Fetch existing lesson
    const existingLesson = await lessonsCollection.findOne(query);

    if (!existingLesson) {
      return res.status(404).json({
        success: false,
        message: "Lesson not found",
      });
    }

    const existingLessonData = existingLesson.lesson || {};

    // TEKS-aligned intro blocks
    const introBlocks = [
      {
        type: "header",
        content: "Understanding Your Money Personality",
        level: "h1",
      },
      {
        type: "text",
        content:
          "Your money personality reflects how you earn, spend, save, and invest your money. Understanding your financial personality helps you make better financial decisions aligned with your values and goals. This lesson aligns with TEKS §113.76(b)(1) - Students will understand personal financial goals and the purposes and uses of money.",
      },
      {
        type: "header",
        content: "What is a Money Personality?",
        level: "h2",
      },
      {
        type: "text",
        content:
          "A money personality is your natural tendency toward managing finances. Some people are savers, others are spenders. Some are risk-takers, others are cautious. Knowing your personality type helps you understand your financial behaviors and make intentional choices about earning, spending, and saving.",
      },
    ];

    // TEKS-aligned lesson blocks
    const lessonBlocks = [
      {
        type: "section",
        header: "TEKS §113.76(b)(2): Earning and Income",
        blocks: [
          {
            type: "header",
            content: "Understanding Earning and Income",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Your income is the money you earn through work, investments, or other sources. The amount you earn affects your ability to spend, save, and invest. Different money personalities approach earning differently—some seek high-income careers, while others prioritize job satisfaction and work-life balance.",
          },
          {
            type: "list",
            items: [
              "Earned income (wages, salary, tips from employment)",
              "Passive income (interest, dividends, rental income)",
              "Gift income (allowance, inheritance, gifts)",
              "Government benefits (scholarships, grants, subsidies)",
            ],
          },
        ],
      },
      {
        type: "section",
        header: "TEKS §113.76(b)(3): Spending and Budgeting",
        blocks: [
          {
            type: "header",
            content: "Spending Decisions and Budget Planning",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Spending is how you use your money to pay for goods and services. A budget is a plan for your money that shows how much you'll earn and how you'll spend it. Your money personality influences your spending habits—whether you're impulsive, deliberate, minimalist, or generous.",
          },
          {
            type: "list",
            items: [
              "Fixed expenses (rent, insurance, utilities that stay the same each month)",
              "Variable expenses (groceries, entertainment, transportation that changes)",
              "Essential expenses (food, shelter, healthcare needed to survive)",
              "Discretionary expenses (entertainment, dining out, hobbies you choose)",
            ],
          },
        ],
      },
      {
        type: "section",
        header: "TEKS §113.76(b)(4): Saving and Goal-Setting",
        blocks: [
          {
            type: "header",
            content: "Saving Strategies and Financial Goals",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Saving is setting aside money for future use. Financial goals guide your saving decisions. Different money personalities have different motivations for saving—security, freedom, opportunity, or generosity. Setting clear goals helps you stay motivated to save.",
          },
          {
            type: "list",
            items: [
              "Emergency savings (3-6 months of expenses for unexpected events)",
              "Short-term savings goals (less than 1 year: vacation, new phone)",
              "Medium-term savings goals (1-5 years: car, college)",
              "Long-term savings goals (5+ years: house, retirement, education)",
            ],
          },
        ],
      },
      {
        type: "section",
        header: "TEKS §113.76(b)(5): Investing and Building Wealth",
        blocks: [
          {
            type: "header",
            content: "Investing for Long-Term Wealth",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Investing is using money to purchase assets that may grow in value or generate income. Risk tolerance varies by money personality—some personalities naturally prefer safer investments, while others are comfortable with higher-risk opportunities for greater returns.",
          },
          {
            type: "list",
            items: [
              "Stocks (ownership shares in companies)",
              "Bonds (loans you make to governments or companies)",
              "Mutual funds (professionally managed investment collections)",
              "Real estate (property ownership for appreciation or rental income)",
              "Retirement accounts (401k, IRA, 403b for future security)",
            ],
          },
        ],
      },
      {
        type: "section",
        header: "TEKS §113.76(b)(6): Credit and Debt Management",
        blocks: [
          {
            type: "header",
            content: "Understanding Credit and Managing Debt",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Credit is borrowing money with the promise to repay it. Debt is money you owe. Your money personality affects how you use credit—some personalities avoid debt entirely, while others use it strategically. Understanding credit helps you borrow wisely and build financial stability.",
          },
          {
            type: "list",
            items: [
              "Credit score (3-digit number reflecting your credit history, 300-850 range)",
              "Credit cards (borrowing tools that require monthly repayment)",
              "Student loans (borrowing for education)",
              "Auto loans (borrowing to purchase vehicles)",
              "Mortgages (long-term borrowing to purchase homes)",
              "Interest rates (cost of borrowing—affects total amount you repay)",
            ],
          },
        ],
      },
      {
        type: "section",
        header: "Money Personalities and Financial Decision-Making",
        blocks: [
          {
            type: "header",
            content: "Recognizing Your Money Personality",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Common money personalities include: The Saver (values security and consistency), The Spender (enjoys experiences and generosity), The Investor (seeks growth and opportunity), The Debtor (comfortable with borrowing), and The Avoider (uncomfortable with financial decisions). Understanding your personality helps you make intentional financial choices.",
          },
          {
            type: "header",
            content: "Aligning Personality with Goals",
            level: "h3",
          },
          {
            type: "text",
            content:
              "Your money personality isn't fixed—you can develop new financial habits. If you're naturally a spender but want to save more, you can set automatic transfers. If you avoid financial decisions, you can create simple systems. The key is understanding yourself and making intentional choices.",
          },
        ],
      },
      {
        type: "section",
        header: "TEKS §113.76(c): Making Wise Financial Decisions",
        blocks: [
          {
            type: "header",
            content: "Decision-Making Framework",
            level: "h3",
          },
          {
            type: "text",
            content:
              "When making financial decisions, consider: What is my goal? What are my options? What are the pros and cons of each option? What are the short-term and long-term consequences? Does this align with my values? This framework helps you make decisions that support your money personality while working toward your goals.",
          },
        ],
      },
    ];

    // Merge with existing data - preserve everything, add/update blocks
    const updatedLesson = {
      _id: numericId || lessonId,
      lesson: {
        ...existingLessonData,
        intro_text_blocks: introBlocks,
        lesson_blocks: lessonBlocks,
        updatedAt: new Date(),
      },
      teacher: existingLesson.teacher,
      unit: existingLesson.unit,
      createdAt: existingLesson.createdAt,
    };

    await lessonsCollection.replaceOne(query, updatedLesson);

    console.log(`✅ Added TEKS-aligned blocks to lesson ${lessonId}`);
    console.log(`   - ${introBlocks.length} intro blocks`);
    console.log(`   - ${lessonBlocks.length} lesson blocks`);

    res.status(200).json({
      success: true,
      message: "TEKS-aligned blocks added successfully",
      lessonId: lessonId,
      blocksAdded: {
        introBlocks: introBlocks.length,
        lessonBlocks: lessonBlocks.length,
      },
    });
  } catch (error) {
    console.error("Failed to add TEKS blocks:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add TEKS blocks: " + error.message,
    });
  }
});

// Bulk fix: Fix ALL lesson conditions in the database
app.post("/fix-all-lesson-conditions", async (req, res) => {
  try {
    console.log("\n--- Bulk Fix All Lesson Conditions ---");

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Find all lessons with conditions that have null condition_value
    const lessons = await lessonsCollection
      .find({
        lesson_conditions: { $exists: true, $not: { $size: 0 } },
        "lesson_conditions.condition_value": null,
      })
      .toArray();

    console.log(
      `Found ${lessons.length} lessons with null condition_value fields`,
    );

    if (lessons.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No lessons need condition_value fixes",
        lessonsProcessed: 0,
        lessonsFixed: 0,
      });
    }

    let lessonsFixed = 0;
    const results = [];

    // Fix each lesson
    for (const lesson of lessons) {
      const fixedConditions = lesson.lesson_conditions.map((condition) => {
        if (
          condition.condition_value === null &&
          condition.value !== undefined
        ) {
          return {
            ...condition,
            condition_value: condition.value,
          };
        }
        return condition;
      });

      // Update the lesson
      await lessonsCollection.updateOne(
        { _id: lesson._id },
        { $set: { lesson_conditions: fixedConditions } },
      );

      lessonsFixed++;
      results.push({
        lessonId: lesson._id,
        lessonTitle:
          lesson.lesson_title || lesson.lesson?.lesson_title || "Unknown",
        conditionsFixed: fixedConditions.filter(
          (c) => c.condition_value === null,
        ).length,
      });

      console.log(
        `✅ Fixed lesson: ${lesson.lesson_title || "Unknown"} (${lesson._id})`,
      );
    }

    res.status(200).json({
      success: true,
      message: `Fixed ${lessonsFixed} lessons with null condition_value fields`,
      lessonsProcessed: lessons.length,
      lessonsFixed: lessonsFixed,
      results: results,
    });
  } catch (error) {
    console.error("Failed to fix all lesson conditions:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fix lesson conditions: " + error.message,
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
      `Found ${unownedLessons.length} unowned lessons to assign to admin`,
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
        `Assigned ${bulkResult.modifiedCount} lessons to admin teacher`,
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
      `Found ${lessons.length} lessons created by admin@trinity-capital.net`,
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

    // Get student's teacher name
    const studentTeacher = studentProfile.teacher;
    console.log(
      `[LESSON API] Student ${studentId} is assigned to teacher: ${studentTeacher}`,
    );

    const MASTER_TEACHER = "admin@trinity-capital.net";

    // CRITICAL LOGIC:
    // 1. If student has a teacher assigned (not master), ONLY show that teacher's lessons
    // 2. If student has no teacher or is assigned to master, show master lessons
    // 3. Never show lessons from other teachers

    let allLessonIds = [];

    if (studentTeacher && studentTeacher !== MASTER_TEACHER) {
      // Student has a non-master teacher assigned
      console.log(
        `[LESSON API] Student has custom teacher, fetching ${studentTeacher}'s lessons only`,
      );

      // Get lesson IDs from assignedUnitIds that match this teacher
      const assignedUnits = Array.isArray(studentProfile.assignedUnitIds)
        ? studentProfile.assignedUnitIds.filter(
            (unit) => unit.teacherName === studentTeacher,
          )
        : [];

      console.log(
        `[LESSON API] Found ${assignedUnits.length} assigned units from teacher ${studentTeacher}`,
      );

      assignedUnits.forEach((unit, idx) => {
        console.log(
          `[LESSON API] Unit[${idx}]: ${unit.unitName} has ${
            unit.lessonIds ? unit.lessonIds.length : 0
          } lessons`,
        );
        if (Array.isArray(unit.lessonIds)) {
          allLessonIds.push(...unit.lessonIds);
        }
      });
    } else {
      // Student is master teacher or has no teacher - show master lessons from assignedUnitIds
      console.log(`[LESSON API] Using master teacher lessons`);

      const assignedUnits = Array.isArray(studentProfile.assignedUnitIds)
        ? studentProfile.assignedUnitIds.filter(
            (unit) => unit.teacherName === MASTER_TEACHER,
          )
        : [];

      console.log(
        `[LESSON API] Found ${assignedUnits.length} assigned units from master teacher`,
      );

      assignedUnits.forEach((unit, idx) => {
        console.log(
          `[LESSON API] Unit[${idx}]: ${unit.unitName} has ${
            unit.lessonIds ? unit.lessonIds.length : 0
          } lessons`,
        );
        if (Array.isArray(unit.lessonIds)) {
          allLessonIds.push(...unit.lessonIds);
        }
      });
    }

    // Remove duplicates and filter falsy values
    allLessonIds = [...new Set(allLessonIds)].filter(Boolean);
    console.log(
      `[LESSON API] All lessonIds collected: ${allLessonIds.length} unique IDs`,
    );

    if (allLessonIds.length === 0) {
      console.log(`[LESSON API] No lessons assigned for student: ${studentId}`);
      return res.status(200).json({
        success: true,
        lessons: [],
        message: "No lessons assigned to student.",
      });
    }

    // Fetch lessons from Lessons collection by _id (convert string IDs to multiple formats)
    const { ObjectId } = require("mongodb");
    const studentLessonsCollection = client
      .db("TrinityCapital")
      .collection("Lessons");

    // Helper function to check if a string is a valid MongoDB ObjectId hex string
    const isValidObjectIdHex = (str) => {
      return typeof str === "string" && /^[0-9a-f]{24}$/i.test(str);
    };

    // Helper function to check if a string is a valid numeric ID
    const isNumericId = (str) => {
      return !isNaN(str) && str.trim() !== "";
    };

    // Build query to fetch lessons - handle multiple ID formats
    const objectIdArray = [];
    const numericIdArray = [];

    allLessonIds.forEach((id) => {
      if (isValidObjectIdHex(id)) {
        try {
          objectIdArray.push(new ObjectId(id));
        } catch (e) {
          console.log(`⚠️ Failed to convert to ObjectId: ${id}`);
        }
      } else if (isNumericId(id)) {
        numericIdArray.push(parseInt(id, 10));
      }
    });

    console.log(
      `[LESSON API] ID Processing: ${objectIdArray.length} ObjectIds, ${numericIdArray.length} numeric IDs`,
    );

    // Fetch lessons with both ID types
    let lessonDocs = [];

    // Query by ObjectIds
    if (objectIdArray.length > 0) {
      const objectIdResults = await studentLessonsCollection
        .find({ _id: { $in: objectIdArray } })
        .toArray();
      lessonDocs.push(...objectIdResults);
      console.log(
        `[LESSON API] Found ${objectIdResults.length} lessons by ObjectId`,
      );
    }

    // Query by numeric IDs
    if (numericIdArray.length > 0) {
      const numericIdResults = await studentLessonsCollection
        .find({ _id: { $in: numericIdArray } })
        .toArray();
      lessonDocs.push(...numericIdResults);
      console.log(
        `[LESSON API] Found ${numericIdResults.length} lessons by numeric ID`,
      );
    }

    // Debug: Log found lessons
    console.log(
      `[LESSON API] Found ${lessonDocs.length} total lessons for student: ${studentId}`,
    );
    lessonDocs.forEach((doc, idx) => {
      console.log(
        `[LESSON API] Lesson[${idx}]: _id=${doc._id}, title=${doc.lesson_title || "No title"}`,
      );
    });

    // Format lessons for frontend - handle both nested and flat lesson structures
    const lessons = lessonDocs.map((doc) => {
      // Handle both nested lesson structure and flat structure
      return {
        _id: doc._id,
        lesson_title: doc.lesson_title || doc.lesson?.lesson_title || "",
        lesson_description:
          doc.lesson_description || doc.lesson?.lesson_description || "",
        content: doc.content || doc.lesson?.content || [],
        lesson_blocks: doc.lesson_blocks || doc.lesson?.lesson_blocks || [],
        lesson_conditions:
          doc.lesson_conditions || doc.lesson?.lesson_conditions || [],
        learning_objectives:
          doc.learning_objectives || doc.lesson?.learning_objectives || [],
        intro_text_blocks:
          doc.intro_text_blocks || doc.lesson?.intro_text_blocks || [],
        required_actions:
          doc.required_actions || doc.lesson?.required_actions || [],
        success_metrics:
          doc.success_metrics || doc.lesson?.success_metrics || {},
        teacher: doc.teacher,
        unit: doc.unit,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    });

    console.log(
      `[LESSON API] Returning ${lessons.length} formatted lessons to frontend for student: ${studentId}`,
    );
    res.status(200).json({
      success: true,
      lessons,
      studentTeacher: studentTeacher,
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

/**
 * SAMPLE TEACHER DATA CLEANUP ENDPOINTS
 * These endpoints are called when a sample teacher logs out or closes the page
 * They clear the units array and delete all lessons for that teacher
 */

/**
 * DELETE /api/sample-teacher-cleanup/:teacherName
 * Clears units array and deletes all lessons for a sample teacher
 * Called on logout, refresh, or page close
 */
app.delete("/api/sample-teacher-cleanup/:teacherName", async (req, res) => {
  try {
    const { teacherName } = req.params;

    if (!teacherName) {
      return res.status(400).json({ error: "Missing teacherName parameter" });
    }

    console.log(
      `🗑️  [SampleTeacherCleanup] Starting cleanup for teacher: ${teacherName}`,
    );

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // Step 1: Clear the units array for this teacher
    const teacherUpdateResult = await teachersCollection.updateOne(
      { name: teacherName },
      {
        $set: {
          units: [], // Clear ALL units
          students: [], // Also clear students array
          messages: [], // Clear messages
        },
      },
    );

    console.log(
      `✅ [SampleTeacherCleanup] Cleared units for ${teacherName}: matched=${teacherUpdateResult.matchedCount}, modified=${teacherUpdateResult.modifiedCount}`,
    );

    // Step 2: Delete all lessons created by this teacher
    const lessonsDeleteResult = await lessonsCollection.deleteMany({
      teacher: teacherName,
    });

    console.log(
      `✅ [SampleTeacherCleanup] Deleted ${lessonsDeleteResult.deletedCount} lessons for ${teacherName}`,
    );

    // Emit Socket.IO event to notify connected clients
    io.emit("sampleTeacherDataCleaned", {
      teacherName: teacherName,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      message: `Sample teacher data cleaned for ${teacherName}`,
      unitsCleared: teacherUpdateResult.modifiedCount > 0,
      lessonsDeleted: lessonsDeleteResult.deletedCount,
    });
  } catch (error) {
    console.error("Error during sample teacher cleanup:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cleanup sample teacher data: " + error.message,
    });
  }
});

/**
 * POST /api/sample-teacher-cleanup/:teacherName
 * Alternative POST endpoint for cleanup (in case DELETE doesn't work via fetch sendBeacon)
 */
app.post("/api/sample-teacher-cleanup/:teacherName", async (req, res) => {
  try {
    const { teacherName } = req.params;
    const decodedTeacherName = decodeURIComponent(teacherName);

    if (!decodedTeacherName) {
      return res.status(400).json({ error: "Missing teacherName parameter" });
    }

    console.log("\n" + "=".repeat(80));
    console.log(
      `🗑️  [SampleTeacherCleanup-POST] Starting cleanup for teacher: ${decodedTeacherName}`,
    );
    console.log("=".repeat(80));

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");
    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    // DEBUG: Check what's in the database BEFORE cleanup
    console.log(`\n📋 [DEBUG] Checking lessons BEFORE cleanup...`);
    const lessonsBeforeDelete = await lessonsCollection
      .find({ teacher: decodedTeacherName })
      .toArray();
    console.log(
      `Found ${lessonsBeforeDelete.length} lessons for teacher: ${decodedTeacherName}`,
    );
    lessonsBeforeDelete.forEach((lesson, idx) => {
      console.log(
        `  [${idx + 1}] Lesson ID: ${lesson._id}, Teacher: "${lesson.teacher}", Title: "${
          lesson.lesson_title || "N/A"
        }"`,
      );
    });

    // DEBUG: Check teacher document
    console.log(`\n📋 [DEBUG] Checking teacher document...`);
    const teacherDoc = await teachersCollection.findOne({
      name: decodedTeacherName,
    });
    if (teacherDoc) {
      console.log(`✓ Teacher found: ${teacherDoc.name}`);
      console.log(
        `  Units count: ${teacherDoc.units ? teacherDoc.units.length : 0}`,
      );
      if (teacherDoc.units && teacherDoc.units.length > 0) {
        teacherDoc.units.forEach((unit, idx) => {
          console.log(
            `    [${idx + 1}] Unit: ${unit.name}, Lessons: ${
              unit.lessons ? unit.lessons.length : 0
            }`,
          );
        });
      }
    } else {
      console.log(`✗ Teacher not found: ${decodedTeacherName}`);
    }

    // Step 1: Clear the units array for this teacher
    console.log(`\n🔄 [STEP 1] Clearing units array...`);
    const teacherUpdateResult = await teachersCollection.updateOne(
      { name: decodedTeacherName },
      {
        $set: {
          units: [], // Clear ALL units
          students: [], // Also clear students array
          messages: [], // Clear messages
        },
      },
    );

    console.log(
      `✅ Cleared units for ${decodedTeacherName}: matched=${teacherUpdateResult.matchedCount}, modified=${teacherUpdateResult.modifiedCount}`,
    );

    // Step 2: Delete all lessons created by this teacher
    console.log(`\n🔄 [STEP 2] Deleting lessons...`);
    console.log(`Query: { teacher: "${decodedTeacherName}" }`);
    const lessonsDeleteResult = await lessonsCollection.deleteMany({
      teacher: decodedTeacherName,
    });

    console.log(
      `✅ Deleted ${lessonsDeleteResult.deletedCount} lessons for ${decodedTeacherName}`,
    );

    // DEBUG: Verify lessons are deleted
    console.log(`\n📋 [DEBUG] Checking lessons AFTER cleanup...`);
    const lessonsAfterDelete = await lessonsCollection
      .find({ teacher: decodedTeacherName })
      .toArray();
    console.log(`Found ${lessonsAfterDelete.length} lessons remaining`);
    if (lessonsAfterDelete.length > 0) {
      console.log("⚠️  WARNING: Lessons still exist after delete!");
      lessonsAfterDelete.forEach((lesson) => {
        console.log(`  Remaining: ${lesson._id} - ${lesson.lesson_title}`);
      });
    }

    // Emit Socket.IO event to notify connected clients
    io.emit("sampleTeacherDataCleaned", {
      teacherName: decodedTeacherName,
      timestamp: new Date().toISOString(),
    });

    console.log("=".repeat(80) + "\n");

    res.status(200).json({
      success: true,
      message: `Sample teacher data cleaned for ${decodedTeacherName}`,
      unitsCleared: teacherUpdateResult.modifiedCount > 0,
      lessonsDeleted: lessonsDeleteResult.deletedCount,
    });
  } catch (error) {
    console.error("Error during sample teacher cleanup:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cleanup sample teacher data: " + error.message,
    });
  }
});

// DEBUG ENDPOINT: Get all lessons for a specific teacher
app.get("/api/debug/lessons/:teacherName", async (req, res) => {
  try {
    const { teacherName } = req.params;
    const decodedTeacherName = decodeURIComponent(teacherName);

    console.log(
      `\n🔍 [DEBUG-GET] Querying lessons for teacher: ${decodedTeacherName}`,
    );

    const lessonsCollection = client.db("TrinityCapital").collection("Lessons");

    const lessons = await lessonsCollection
      .find({ teacher: decodedTeacherName })
      .toArray();

    console.log(`Found ${lessons.length} lessons for ${decodedTeacherName}`);
    lessons.forEach((lesson) => {
      console.log(
        `  - ID: ${lesson._id}, Title: "${lesson.lesson_title}", Teacher: "${lesson.teacher}"`,
      );
    });

    res.status(200).json({
      success: true,
      teacherName: decodedTeacherName,
      lessonCount: lessons.length,
      lessons: lessons,
    });
  } catch (error) {
    console.error("Error getting debug lessons:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// DEBUG ENDPOINT: Get teacher document details
app.get("/api/debug/teacher/:teacherName", async (req, res) => {
  try {
    const { teacherName } = req.params;
    const decodedTeacherName = decodeURIComponent(teacherName);

    console.log(
      `\n🔍 [DEBUG-GET] Querying teacher document: ${decodedTeacherName}`,
    );

    const teachersCollection = client
      .db("TrinityCapital")
      .collection("Teachers");

    const teacher = await teachersCollection.findOne({
      name: decodedTeacherName,
    });

    if (teacher) {
      console.log(`✓ Found teacher: ${teacher.name}`);
      console.log(`  Units: ${teacher.units ? teacher.units.length : 0}`);
      console.log(
        `  Students: ${teacher.students ? teacher.students.length : 0}`,
      );
      console.log(
        `  Messages: ${teacher.messages ? teacher.messages.length : 0}`,
      );
    } else {
      console.log(`✗ Teacher not found: ${decodedTeacherName}`);
    }

    res.status(200).json({
      success: true,
      teacher: teacher || null,
    });
  } catch (error) {
    console.error("Error getting debug teacher:", error);
    res.status(500).json({
      success: false,
      error: error.message,
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
        `  ⚠️ WARNING: Both colon and question mark in route path: ${route.path}`,
      );
    }

    // Split the path into segments and check each parameter
    const segments = route.path.split("/");
    segments.forEach((segment) => {
      if (segment.startsWith(":")) {
        const paramName = segment.substring(1);
        if (!paramName || paramName.length === 0) {
          console.error(
            `  ⚠️ WARNING: Empty parameter name in route path: ${route.path}`,
          );
        }
        if (
          paramName.includes(":") ||
          paramName.includes("/") ||
          paramName.includes("?")
        ) {
          console.error(
            `  ⚠️ WARNING: Invalid character in parameter name '${paramName}' in route path: ${route.path}`,
          );
        }
      }
    });
  });

  console.log("===== END ROUTE VALIDATION =====\n");
}

// Run validation after all routes are registered
validateRoutes();
