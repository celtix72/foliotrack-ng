/**
 * FolioTrack Web Push Client Helper
 */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Push] Web Push o Service Workers non supportati da questo browser.');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return registration;
  } catch (err) {
    console.error('[Push] Errore di registrazione del Service Worker:', err);
    return null;
  }
}

async function checkPushSubscriptionStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { supported: false, subscribed: false };
  }

  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    return { supported: true, subscribed: false };
  }

  const subscription = await reg.pushManager.getSubscription();
  return {
    supported: true,
    subscribed: Boolean(subscription),
    subscription
  };
}

async function subscribeUserToPush() {
  const reg = await registerServiceWorker();
  if (!reg) {
    throw new Error('Service Worker non disponibile in questo browser.');
  }

  // Get Public Key from server
  const keyRes = await fetch('/api/push/vapid-public-key');
  const keyData = await keyRes.json();
  if (!keyData.success || !keyData.publicKey) {
    throw new Error(keyData.error || 'Impossibile recuperare la chiave VAPID pubblica.');
  }

  const convertedVapidKey = urlBase64ToUint8Array(keyData.publicKey);

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: convertedVapidKey
  });

  // Save subscription to server
  const saveRes = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription })
  });

  const saveData = await saveRes.json();
  if (!saveData.success) {
    throw new Error(saveData.error || 'Errore nel salvataggio della sottoscrizione.');
  }

  return subscription;
}

async function unsubscribeUserFromPush() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;

  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return true;

  // Inform server
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
  } catch (err) {
    console.warn('[Push] Errore informando il server della disiscrizione:', err);
  }

  // Unsubscribe in browser
  return await subscription.unsubscribe();
}

window.FolioTrackPush = {
  registerServiceWorker,
  checkPushSubscriptionStatus,
  subscribeUserToPush,
  unsubscribeUserFromPush
};

