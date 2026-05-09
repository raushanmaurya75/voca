// Use background script for Supabase auth to avoid CSP issues
async function callBackgroundAuth(type, data) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: `voca:auth:${type}`, data }, resolve);
    });
}

function showTab(tab) {
    const signinForm = document.getElementById('signin-form');
    const signupForm = document.getElementById('signup-form');
    const tabs = document.querySelectorAll('.tab');
    
    tabs.forEach(t => t.classList.remove('active'));
    
    if (tab === 'signin') {
        signinForm.classList.remove('hidden');
        signupForm.classList.add('hidden');
        tabs[0].classList.add('active');
    } else {
        signinForm.classList.add('hidden');
        signupForm.classList.remove('hidden');
        tabs[1].classList.add('active');
    }
    hideMessages();
}

function showError(msg) {
    const errorEl = document.getElementById('error');
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    document.getElementById('success').style.display = 'none';
}

function showSuccess(msg) {
    const successEl = document.getElementById('success');
    successEl.textContent = msg;
    successEl.style.display = 'block';
    document.getElementById('error').style.display = 'none';
}

function hideMessages() {
    document.getElementById('error').style.display = 'none';
    document.getElementById('success').style.display = 'none';
}

// Tab button event listeners
document.getElementById('tab-signin').addEventListener('click', () => showTab('signin'));
document.getElementById('tab-signup').addEventListener('click', () => showTab('signup'));

// Sign In
document.getElementById('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    
    const btn = document.getElementById('signin-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    const email = document.getElementById('signin-email').value;
    const password = document.getElementById('signin-password').value;

    console.log('Attempting email sign-in for:', email);

    const result = await callBackgroundAuth('signin', { email, password });

    if (result.error) {
        console.error('Email sign-in error:', result.error);
        showError(result.error);
        btn.disabled = false;
        btn.textContent = 'Sign In';
        return;
    }

    console.log('Sign-in successful:', result.user?.email);
    showSuccess('Signed in successfully! Redirecting...');
    
    setTimeout(() => {
        window.close();
    }, 1500);
});

// Sign Up
document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessages();
    
    const btn = document.getElementById('signup-btn');
    btn.disabled = true;
    btn.textContent = 'Creating account...';

    const name = document.getElementById('signup-name').value;
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;

    console.log('Attempting sign-up for:', email);

    const result = await callBackgroundAuth('signup', { email, password, name });

    if (result.error) {
        console.error('Sign-up error:', result.error);
        showError(result.error);
        btn.disabled = false;
        btn.textContent = 'Create Account';
        return;
    }

    if (result.user) {
        console.log('Sign-up successful:', result.user?.email);
        showSuccess('Account created! Redirecting...');
        setTimeout(() => {
            window.close();
        }, 1500);
    } else {
        showSuccess(result.message || 'Check your email to confirm your account!');
        btn.disabled = false;
        btn.textContent = 'Create Account';
    }
});

// Check if already logged in via background script
async function checkAuth() {
    const result = await callBackgroundAuth('check', {});
    if (result.authenticated) {
        showSuccess('Signed in successfully! Closing...');
        setTimeout(() => window.close(), 1500);
        return true;
    }
    return false;
}

// Handle OAuth callback
async function handleOAuthCallback() {
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        const expiresIn = params.get('expires_in');
        
        if (accessToken) {
            const tokenData = JSON.parse(atob(accessToken.split('.')[1]));
            const user = {
                id: tokenData.sub,
                email: tokenData.email,
                user_metadata: tokenData.user_metadata || {}
            };
            
            const vocaUser = {
                id: user.id,
                email: user.email,
                access_token: accessToken,
                refresh_token: refreshToken,
                expires_at: Date.now() + (expiresIn * 1000)
            };
            await chrome.storage.local.set({ vocaUser });

            showSuccess('Google sign-in successful! Closing...');
            setTimeout(() => window.close(), 1500);
            return true;
        }
    }
    return false;
}

// Run OAuth handler first, then regular auth check
handleOAuthCallback().then(handled => {
    if (!handled) {
        checkAuth();
    }
});

// Google Sign In - uses background script
document.getElementById('btn-google').addEventListener('click', async () => {
    hideMessages();
    const btn = document.getElementById('btn-google');
    btn.disabled = true;
    btn.innerHTML = '<span style="color: #666;">Connecting...</span>';

    const result = await callBackgroundAuth('google', {});

    if (result.error) {
        console.error('Google auth error:', result.error);
        showError('Google sign-in failed: ' + result.error);
        btn.disabled = false;
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google`;
        return;
    }

    if (result.success) {
        showSuccess('Google sign-in successful! Closing...');
        setTimeout(() => window.close(), 1500);
    }
});
