'use strict';

const WORKER_URL = 'https://voca-backend.tivitji.workers.dev';
let selectedRating = 0;

// DOM Elements
const stars = document.querySelectorAll('.star');
const commentArea = document.getElementById('comment');
const submitBtn = document.getElementById('submit-feedback');
const statusMsg = document.getElementById('status-msg');
const formView = document.getElementById('form-view');
const successView = document.getElementById('success-view');

// 1. Star Rating Logic
stars.forEach(star => {
    star.addEventListener('mouseover', () => {
        const val = parseInt(star.dataset.value);
        highlightStars(val);
    });

    star.addEventListener('mouseout', () => {
        highlightStars(selectedRating);
    });

    star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.value);
        highlightStars(selectedRating);
        submitBtn.disabled = false;
    });
});

function highlightStars(val) {
    stars.forEach(s => {
        const sVal = parseInt(s.dataset.value);
        if (sVal <= val) {
            s.classList.add('active');
        } else {
            s.classList.remove('active');
        }
    });
}

// 2. Submit Logic
submitBtn.addEventListener('click', async () => {
    const comment = commentArea.value.trim();
    
    // Get user token
    const { vocaSession } = await chrome.storage.local.get('vocaSession');
    if (!vocaSession?.access_token) {
        statusMsg.textContent = 'Error: Not authenticated. Please sign in again.';
        statusMsg.className = 'status-msg error';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    statusMsg.textContent = '';

    try {
        const response = await fetch(`${WORKER_URL}/v1/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${vocaSession.access_token}`
            },
            body: JSON.stringify({
                rating: selectedRating,
                comment: comment
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to submit feedback');
        }

        // Success!
        formView.style.display = 'none';
        successView.style.display = 'block';
        
        // Mark as given feedback locally to avoid prompting again
        await chrome.storage.local.set({ 
            hasGivenFeedback: true,
            lastFeedbackTime: Date.now()
        });

    } catch (err) {
        statusMsg.textContent = err.message;
        statusMsg.className = 'status-msg error';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Feedback';
    }
});
