
// login.js
import { auth, provider } from './firebase-config.js';
import { signInWithPopup } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js";

document.getElementById('loginBtn').addEventListener('click', () => {
    signInWithPopup(auth, provider)
        .then((result) => result.user.getIdToken())
        .then((token) => {
            console.log('Token recibido:', token);
            // Aquí puedes enviar el token al backend
            fetch('/api/mis-reservas', {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` }
            })
            .then(response => response.json())
            .then(data => console.log('Reservas:', data));
        })
        .catch((error) => console.error('Error en login:', error));
});
