/**
 * WiFi Captive Portal Payment System
 * Handles M-Pesa payments and MikroTik hotspot access control
 */

document.addEventListener('DOMContentLoaded', function() {
    // ======================
    // DOM Elements
    // ======================
    const packageCards = document.querySelectorAll('.package-card');
    const paymentModal = document.getElementById('paymentModal');
    const closeBtn = document.querySelector('.close-btn');
    const selectedPackageSpan = document.getElementById('selectedPackage');
    const selectedAmountSpan = document.getElementById('selectedAmount');
    const phoneInput = document.getElementById('phone');
    const payNowBtn = document.getElementById('payNowBtn');
    const paymentStatus = document.getElementById('paymentStatus');
    const statusText = document.getElementById('statusText');
    const loader = document.getElementById('loader');

    // ======================
    // Configuration
    // ======================
    const config = {
        // Backend API endpoints (UPDATE THESE TO MATCH YOUR BACKEND)
        apiBaseUrl: 'https://your-backend-domain.com/api',// Your backend URL
        stkPushEndpoint: '/stkpush',// Should match your backend route
        verifyPaymentEndpoint: '/verify-payment',// Need to implement this on backend
        
        // MikroTik API configuration (SECURE THESE IN PRODUCTION)
        mikrotikApiUrl: 'https://your-mikrotik-api-proxy.com/hotspot',// Should proxy through your backend
        mikrotikAuth: 'Basic ' + btoa('admin:yourpassword'), // Never expose this in frontend in production
        
        // Payment polling settings
        pollingInterval: 5000, // 5 seconds
        maxPollingAttempts: 12 // 1 minute total (12 * 5s)
    };



    // ======================
    // State Variables
    // ======================
    let selectedDuration = 0;
    let selectedPrice = 0;
    let checkoutRequestID = '';
    let pollingAttempts = 0;
    let pollingIntervalId = null;
    let userIP = '';
    let userMAC = '';

    // ======================
    // Initialization
    // ======================
    init();

    function init() {
        // Set up event listeners
        setupEventListeners();
        
        // Capture user connection info from URL parameters
        captureConnectionInfo();
    }

    // ======================
    // Event Listeners Setup
    // ======================
    function setupEventListeners() {
        // Package selection
        packageCards.forEach(card => {
            card.addEventListener('click', handlePackageSelection);
        });

        // Modal close button
        closeBtn.addEventListener('click', closePaymentModal);

        // Pay now button
        payNowBtn.addEventListener('click', handlePayment);

        // Close modal when clicking outside
        window.addEventListener('click', function(event) {
            if (event.target === paymentModal) {
                closePaymentModal();
            }
        });
    }

    // ======================
    // Core Functions
    // ======================

    /**
     * Handles package selection
     */
    function handlePackageSelection() {
        selectedDuration = this.getAttribute('data-duration');
        selectedPrice = this.getAttribute('data-price');
        
        selectedPackageSpan.textContent = `${selectedDuration} Hour${selectedDuration > 1 ? 's' : ''} Package`;
        selectedAmountSpan.textContent = selectedPrice;
        
        // Show payment modal
        paymentModal.style.display = 'block';
        resetPaymentUI();
    }

    /**
     * Handles the payment process
     */
    async function handlePayment() {
        const phoneNumber = phoneInput.value.trim();
        
        // Validate phone number
        if (!validatePhoneNumber(phoneNumber)) {
            showError('Please enter a valid M-Pesa phone number in the format 2547XXXXXXXX');
            return;
        }

        try {
            showLoading('Initiating payment...');
            
            // 1. Initiate STK Push
            const stkResponse = await initiateSTKPush(phoneNumber, selectedPrice, selectedDuration);
            
            if (stkResponse.status === true) {
                checkoutRequestID = stkResponse.checkoutRequestID;
                showLoading('Please enter your M-Pesa PIN on your phone');
                
                // 2. Start polling for payment status
                startPaymentPolling(checkoutRequestID);
            } else {
                throw new Error(stkResponse.msg || 'Failed to initiate payment');
            }
        } catch (error) {
            console.error('Payment Error:', error);
            showError(error.message || 'Payment failed. Please try again.');
        }
    }

    /**
     * Initiates M-Pesa STK Push
     */
    async function initiateSTKPush(phoneNumber, amount, duration) {
        const requestData = {
            phone: phoneNumber,
            amount: amount,
            accountNumber: `WIFI_${duration}HRS`
        };

        try {
            const response = await fetch(`${config.apiBaseUrl}${config.stkPushEndpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('STK Push Error:', error);
            throw error;
        }
    }

    /**
     * Starts polling for payment status
     */
    function startPaymentPolling(checkoutRequestID) {
        pollingAttempts = 0;
        clearInterval(pollingIntervalId);
        
        pollingIntervalId = setInterval(async () => {
            pollingAttempts++;
            
            if (pollingAttempts > config.maxPollingAttempts) {
                clearInterval(pollingIntervalId);
                showError('Payment timeout. Please try again.');
                return;
            }

            try {
                showLoading(`Checking payment status (${pollingAttempts}/${config.maxPollingAttempts})`);
                
                const verification = await verifyPayment(checkoutRequestID);
                
                if (verification.status === true && verification.ResultCode === "0") {
                    // Payment successful
                    clearInterval(pollingIntervalId);
                    
                    // Grant MikroTik access
                    const mikrotikResponse = await grantMikrotikAccess({
                        ip: userIP,
                        mac: userMAC,
                        duration: selectedDuration * 3600, // Convert hours to seconds
                        package: `WIFI_${selectedDuration}HRS`
                    });
                    
                    if (mikrotikResponse.success) {
                        showSuccess('Payment successful! WiFi access granted.');
                        // Redirect or close modal after delay
                        setTimeout(() => {
                            closePaymentModal();
                            // In a real implementation, you might redirect or refresh
                            alert(`Enjoy your ${selectedDuration} hour${selectedDuration > 1 ? 's' : ''} of WiFi access!`);
                        }, 2000);
                    } else {
                        showError('Payment succeeded but failed to grant access. Contact support.');
                    }
                } else if (verification.ResultCode && verification.ResultCode !== "0") {
                    // Payment failed
                    clearInterval(pollingIntervalId);
                    showError(verification.ResultDesc || 'Payment failed. Please try again.');
                }
                // If still processing, continue polling
            } catch (error) {
                console.error('Polling Error:', error);
                // Don't stop polling for network errors
            }
        }, config.pollingInterval);
    }

    /**
     * Verifies payment with backend
     */
    async function verifyPayment(checkoutRequestID) {
        try {
            const response = await fetch(`${config.apiBaseUrl}${config.verifyPaymentEndpoint}?requestID=${checkoutRequestID}`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Verification Error:', error);
            throw error;
        }
    }

    /**
     * Grants access on MikroTik hotspot
     */
    async function grantMikrotikAccess(userData) {
        // In production, this should be handled by your backend
        // This frontend implementation is for demonstration only
        try {
            const response = await fetch(config.mikrotikApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': config.mikrotikAuth
                },
                body: JSON.stringify({
                    ip: userData.ip,
                    mac: userData.mac,
                    duration: userData.duration,
                    comment: userData.package
                })
            });
            
            if (!response.ok) {
                throw new Error('MikroTik API failed');
            }
            
            const data = await response.json();
            return { success: true, data };
        } catch (error) {
            console.error('MikroTik Error:', error);
            return { success: false, error: error.message };
        }
    }

    // ======================
    // Helper Functions
    // ======================

    /**
     * Captures user connection info from URL parameters
     */
    function captureConnectionInfo() {
        const urlParams = new URLSearchParams(window.location.search);
        userIP = urlParams.get('ip') || '';
        userMAC = urlParams.get('mac') || '';
        
        // For testing if not provided by MikroTik
        if (!userIP) userIP = '192.168.1.100';
        if (!userMAC) userMAC = 'AA:BB:CC:DD:EE:FF';
        
        console.log('User Connection Info:', { ip: userIP, mac: userMAC });
    }

    /**
     * Validates M-Pesa phone number
     */
    function validatePhoneNumber(phone) {
        return /^254\d{9}$/.test(phone);
    }

    /**
     * Resets payment UI to initial state
     */
    function resetPaymentUI() {
        phoneInput.value = '';
        paymentStatus.style.display = 'none';
        statusText.textContent = '';
        loader.style.display = 'none';
        payNowBtn.disabled = false;
        clearInterval(pollingIntervalId);
    }

    /**
     * Shows loading state
     */
    function showLoading(message = 'Processing...') {
        paymentStatus.style.display = 'block';
        loader.style.display = 'block';
        statusText.textContent = message;
        statusText.style.color = '#333';
        payNowBtn.disabled = true;
    }

    /**
     * Shows success state
     */
    function showSuccess(message = 'Success!') {
        loader.style.display = 'none';
        statusText.textContent = message;
        statusText.style.color = '#4CAF50';
        payNowBtn.disabled = true;
    }

    /**
     * Shows error state
     */
    function showError(message = 'An error occurred.') {
        loader.style.display = 'none';
        statusText.textContent = message;
        statusText.style.color = '#f44336';
        payNowBtn.disabled = false;
    }

    /**
     * Closes payment modal
     */
    function closePaymentModal() {
        paymentModal.style.display = 'none';
        resetPaymentUI();
    }
});