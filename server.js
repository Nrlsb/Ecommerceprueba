// server.js (Versión Final para Despliegue)
// Carga las variables de entorno desde el archivo .env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const admin = require('firebase-admin');

// --- CONFIGURACIÓN ---
const app = express();
const port = process.env.PORT || 3000; // Usa el puerto del hosting o 3000 si es local

const mercadoPagoAccessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
// Para producción, leeremos las credenciales desde una variable de entorno JSON.
// Para desarrollo, usaremos la ruta del archivo.
const firebaseCredentialsJson = process.env.FIREBASE_CREDENTIALS_JSON;
const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

let serviceAccount;

if (firebaseCredentialsJson) {
    // Entorno de producción: Parsea las credenciales desde la variable de entorno
    try {
        serviceAccount = JSON.parse(firebaseCredentialsJson);
    } catch (error) {
        console.error('Error al parsear FIREBASE_CREDENTIALS_JSON:', error);
        process.exit(1);
    }
} else if (firebaseServiceAccountPath) {
    // Entorno de desarrollo local: Carga las credenciales desde el archivo
    try {
        serviceAccount = require(firebaseServiceAccountPath);
    } catch (error) {
        console.error('Error al cargar el archivo de credenciales de Firebase desde la ruta:', error);
        process.exit(1);
    }
} else {
    console.error('Error: No se encontraron las credenciales de Firebase.');
    console.error('Define FIREBASE_CREDENTIALS_JSON (para producción) o FIREBASE_SERVICE_ACCOUNT_PATH (para desarrollo).');
    process.exit(1);
}

// Inicializa Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Inicializa Mercado Pago
const client = new MercadoPagoConfig({ accessToken: mercadoPagoAccessToken });
const preference = new Preference(client);
const payment = new Payment(client);

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- ENDPOINTS ---
app.post('/create_preference', async (req, res) => {
    try {
        const { items, payer_email, metadata } = req.body;
        
        // ¡IMPORTANTE! Las URLs deben ser las de tu sitio web público, no localhost.
        // Puedes obtenerlas de variables de entorno para mayor flexibilidad.
        const siteUrl = process.env.SITE_URL || 'http://127.0.0.1:5500';
        
        const body = {
            items,
            payer: { email: payer_email },
            back_urls: {
                success: `${siteUrl}/pago-exitoso.html`,
                failure: `${siteUrl}/checkout.html`,
                pending: `${siteUrl}/checkout.html`
            },
            auto_return: "approved",
            metadata,
        };

        const result = await preference.create({ body });
        console.log('Preferencia creada:', result.id);
        res.json({ id: result.id });

    } catch (error) {
        const errorMessage = error.cause ? JSON.stringify(error.cause, null, 2) : error;
        console.error('Error al crear la preferencia:', errorMessage);
        res.status(500).json({ error: 'Error al crear la preferencia' });
    }
});

app.post('/webhook', async (req, res) => {
    console.log('--- Notificación de Webhook Recibida ---');
    const { type, "data.id": dataId } = req.query;

    if (type === 'payment') {
        try {
            const paymentDetails = await payment.get({ id: dataId });
            if (paymentDetails.status === 'approved') {
                console.log('✅ ¡Pago Aprobado! Procesando el pedido...');
                await procesarPedidoAprobado(paymentDetails);
            } else {
                 console.log(`⚠️ Estado del pago no aprobado: ${paymentDetails.status}`);
            }
        } catch (error) {
            console.error('Error al obtener los detalles del pago:', error);
        }
    }
    res.sendStatus(200);
});

async function procesarPedidoAprobado(paymentDetails) {
    const { id: paymentId, transaction_amount, status, metadata } = paymentDetails;
    const items = paymentDetails.additional_info?.items || [];

    try {
        const pedidoRef = await db.collection('pedidos').add({
            paymentId, status, monto: transaction_amount, items, cliente: metadata,
            fechaCreacion: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Pedido guardado en Firestore con el ID: ${pedidoRef.id}`);
    } catch (error) {
        console.error("Error al guardar el pedido en Firestore:", error);
        return;
    }

    try {
        await db.runTransaction(async (transaction) => {
            const updates = items.map(item => {
                const productRef = db.collection('productos').doc(item.id);
                return transaction.get(productRef).then(doc => {
                    if (!doc.exists) throw new Error(`Producto con ID ${item.id} no encontrado.`);
                    const newStock = doc.data().stock - parseInt(item.quantity, 10);
                    if (newStock < 0) throw new Error(`Stock insuficiente para el producto ${item.title}.`);
                    transaction.update(productRef, { stock: newStock });
                });
            });
            await Promise.all(updates);
        });
        console.log("Stock actualizado correctamente para todos los productos.");
    } catch (error) {
        console.error("Error al actualizar el stock:", error);
    }
}

// --- INICIAR SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor corriendo en el puerto ${port}`);
});
