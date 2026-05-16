document.addEventListener('DOMContentLoaded', () => {
    const WORKER_URL = 'https://voca-backend.tivitji.workers.dev';

    document.querySelectorAll('.buy-button').forEach(btn => {
        btn.addEventListener('click', async () => {
            const planText = btn.textContent.toLowerCase();
            let planId = 'starter';
            if (planText.includes('pro')) planId = 'pro';
            if (planText.includes('elite')) planId = 'elite';

            await buyPack(planId, btn);
        });
    });

    async function buyPack(packId, btn) {
        try {
            const { vocaUser, vocaSession } = await chrome.storage.local.get(['vocaUser', 'vocaSession']);
            const token = vocaUser?.access_token || vocaSession?.access_token || vocaUser?.session?.access_token;
            
            if (!token) {
                alert('Please log in to the Voca extension first!');
                return;
            }

            // Redirect to the hosted checkout page on the worker
            // This bypasses the extension's CSP restrictions and allows Razorpay to load
            const checkoutUrl = `${WORKER_URL}/v1/checkout?plan=${encodeURIComponent(packId)}&token=${encodeURIComponent(token)}`;
            
            // Open in a new tab
            window.open(checkoutUrl, '_blank');
            
        } catch (err) {
            console.error('Purchase Error:', err);
            alert('Error: ' + err.message);
        }
    }
});
