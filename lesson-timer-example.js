// Example frontend timer implementation for Trinity Capital Lesson System

class LessonTimer {
  constructor(studentName, lessonId) {
    this.studentName = studentName;
    this.lessonId = lessonId;
    this.elapsedTime = 0; // in seconds
    this.startTime = null;
    this.intervalId = null;
    this.isRunning = false;
  }

  // Fetch existing time from server when starting a lesson
  async initializeTimer() {
    try {
      const response = await fetch(
        `/get-lesson-time/${this.studentName}/${this.lessonId}`
      );
      const data = await response.json();

      if (data.success) {
        this.elapsedTime = data.elapsedTime || 0;
        console.log(`Resuming timer from ${this.elapsedTime} seconds`);
        return this.elapsedTime;
      } else {
        console.log("No existing timer found, starting from 0");
        this.elapsedTime = 0;
        return 0;
      }
    } catch (error) {
      console.error("Error fetching lesson time:", error);
      this.elapsedTime = 0;
      return 0;
    }
  }

  // Start the timer
  startTimer() {
    if (this.isRunning) return;

    this.startTime = Date.now();
    this.isRunning = true;

    this.intervalId = setInterval(() => {
      // Update display every second
      this.updateDisplay();
    }, 1000);

    console.log(
      `Timer started for lesson ${this.lessonId} at ${this.elapsedTime} seconds`
    );
  }

  // Stop the timer and save to server
  async stopTimer() {
    if (!this.isRunning) return;

    clearInterval(this.intervalId);
    this.isRunning = false;

    // Calculate final elapsed time
    const currentTime = Date.now();
    const sessionTime = Math.floor((currentTime - this.startTime) / 1000);
    const totalElapsedTime = this.elapsedTime + sessionTime;

    // Send to server
    try {
      const response = await fetch("/update-lesson-time", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          studentName: this.studentName,
          lessonId: this.lessonId,
          elapsedTime: sessionTime,
        }),
      });

      const data = await response.json();
      if (data.success) {
        console.log(
          `Timer saved successfully. Total time: ${data.totalElapsedTime} seconds`
        );
        this.elapsedTime = data.totalElapsedTime;
      } else {
        console.error("Failed to save timer:", data.message);
      }
    } catch (error) {
      console.error("Error saving timer:", error);
    }

    this.startTime = null;
  }

  // Update the timer display
  updateDisplay() {
    if (!this.isRunning) return;

    const currentTime = Date.now();
    const sessionTime = Math.floor((currentTime - this.startTime) / 1000);
    const totalTime = this.elapsedTime + sessionTime;

    const minutes = Math.floor(totalTime / 60);
    const seconds = totalTime % 60;
    const formattedTime = `${minutes}:${seconds.toString().padStart(2, "0")}`;

    // Update your UI element here
    // document.getElementById('timer-display').textContent = formattedTime;
    console.log(`Timer: ${formattedTime}`);
  }

  // Get current elapsed time without stopping
  getCurrentTime() {
    if (!this.isRunning) return this.elapsedTime;

    const currentTime = Date.now();
    const sessionTime = Math.floor((currentTime - this.startTime) / 1000);
    return this.elapsedTime + sessionTime;
  }

  // Format time for display
  formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }
}

// Usage example:
/*
async function startLesson(studentName, lessonId) {
  const timer = new LessonTimer(studentName, lessonId);

  // Initialize timer with existing time from server
  const existingTime = await timer.initializeTimer();

  // Start the timer
  timer.startTimer();

  // When student logs out or refreshes, stop and save
  window.addEventListener('beforeunload', () => {
    timer.stopTimer();
  });

  // Or manually stop when lesson ends
  // timer.stopTimer();
}
*/
