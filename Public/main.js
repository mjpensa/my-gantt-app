// ... existing code ...
 * Creates and shows the analysis modal.
 * Fetches data from the new /get-task-analysis endpoint.
 */
async function showAnalysisModal(taskIdentifier) {
  // 1. Remove any old modal
  // --- FIX: Replaced optional chaining (?.) with a standard 'if' check ---
  const oldModal = document.getElementById('analysis-modal');
  if (oldModal) {
    oldModal.remove();
  }
  // --- END FIX ---

  // --- NEW: Keep chat history in scope ---
  let chatHistory = [];
  let isAiChatting = false;

  // 2. Create modal structure
  const modalOverlay = document.createElement('div');
// ... existing code ...
  modalContent.className = 'modal-content';
  
  modalContent.innerHTML = `
    <div class="modal-header">
      <h3 class="modal-title">Analyzing...</h3>
      <button class="modal-close" id="modal-close-btn">&times;</button>
    </div>
    <div class="modal-body" id="modal-body-content">
      <!-- Analysis content will go here -->
      <div id="modal-analysis-content">
        <div class="modal-spinner"></div>
      </div>
      <!-- NEW: Chat history will go here -->
      <div id="modal-chat-history"></div>
    </div>
    <!-- NEW: Modal footer with chat form -->
    <div class="modal-footer">
      <form id="modal-chat-form">
        <input type="text" id="modal-chat-input" placeholder="Ask a follow-up question..." autocomplete="off" />
        <button type="submit" id="modal-chat-send-btn">
          <!-- Send Icon SVG -->
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
          </svg>
        </button>
      </form>
    </div>
  `;
  
  modalOverlay.appendChild(modalContent);
// ... existing code ...
  document.getElementById('modal-close-btn').addEventListener('click', () => {
    modalOverlay.remove();
  });

  // --- NEW: Get key elements for chat ---
  const modalBody = document.getElementById('modal-body-content');
  const chatHistoryContainer = document.getElementById('modal-chat-history');
  const chatForm = document.getElementById('modal-chat-form');
  const chatInput = document.getElementById('modal-chat-input');
  const chatButton = document.getElementById('modal-chat-send-btn');
  const analysisContainer = document.getElementById('modal-analysis-content');

  // --- NEW: Chat submit handler ---
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userQuestion = chatInput.value.trim();
    if (!userQuestion || isAiChatting) return;

    isAiChatting = true;
    chatInput.value = '';
    chatInput.disabled = true;
    chatButton.disabled = true;

    // 1. Add user message to history and UI
    chatHistory.push({ role: 'user', text: userQuestion });
    appendChatMessage(userQuestion, 'user');

    // 2. Show typing indicator
    const typingIndicator = appendChatMessage('...', 'ai-typing');

    try {
      // 3. Call new chat endpoint
      const response = await fetch('/chat-on-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskName: taskIdentifier.taskName,
          entity: taskIdentifier.entity,
          userQuestion: userQuestion,
          chatHistory: chatHistory.slice(0, -1) // Send history *before* this question
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Server error in chat");
      }

      const { answer } = await response.json();

      // 4. Add AI response to history
      chatHistory.push({ role: 'ai', text: answer });
      
      // 5. Remove typing indicator and add final response
      typingIndicator.remove();
      appendChatMessage(answer, 'ai');

    } catch (error) {
      console.error("Error during chat:", error);
      typingIndicator.remove();
      appendChatMessage(`Error: ${error.message}`, 'ai-error');
    } finally {
      isAiChatting = false;
      chatInput.disabled = false;
      chatButton.disabled = false;
      chatInput.focus();
    }
  });

  // --- NEW: Helper to add messages to UI ---
  function appendChatMessage(text, type) {
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${type}`; // e.g., 'chat-message user'
    
    if (type === 'ai-typing') {
      messageEl.innerHTML = '<div class="chat-spinner"></div>';
    } else {
      // Simple text formatting (replace newlines with <br>)
      messageEl.innerHTML = text.replace(/\n/g, '<br>');
    }
    
    chatHistoryContainer.appendChild(messageEl);
    // Scroll to bottom
    modalBody.scrollTop = modalBody.scrollHeight;
    return messageEl;
  }


  // 4. Fetch the *initial* analysis data
  try {
// ... existing code ...
    const analysis = await response.json();

    // 5. Populate the modal with the analysis
    document.querySelector('.modal-title').textContent = analysis.taskName;
    analysisContainer.innerHTML = `
      ${buildAnalysisSection('Status', `<span class="status-pill status-${analysis.status.replace(/\s+/g, '-').toLowerCase()}">${analysis.status}</span>`)}
// ... existing code ...
      ${buildAnalysisSection('Summary', analysis.summary)}
      ${buildAnalysisSection('Rationale / Hurdles', analysis.rationale)}
    `;

    // --- NEW: Add initial AI chat message ---
    appendChatMessage("Ask me any follow-up questions about this task.", 'ai');

  } catch (error) {
    console.error("Error fetching analysis:", error);
    analysisContainer.innerHTML = `<div class="modal-error">Failed to load analysis: ${error.message}</div>`;
  }
}

// Helper function to build a section of the modal
// ... existing code ...