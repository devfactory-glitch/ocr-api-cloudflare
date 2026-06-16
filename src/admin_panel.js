import { Hono } from 'hono';

const admin = new Hono();

// Route pour l'interface visuelle
admin.get('/dashboard', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Dashboard OCR</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-900 text-white font-sans p-8">
        <div class="max-w-5xl mx-auto">
            <h1 class="text-3xl font-bold mb-8 border-b border-gray-700 pb-4">OCR API - Console de Contrôle</h1>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
                <div class="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
                    <p class="text-gray-400 text-sm uppercase">Statut API</p>
                    <p class="text-2xl font-bold text-green-400">En Ligne</p>
                </div>
                <div class="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
                    <p class="text-gray-400 text-sm uppercase">Dernier OCR</p>
                    <p class="text-2xl font-bold text-blue-400">Il y a 2 min</p>
                </div>
                <div class="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
                    <p class="text-gray-400 text-sm uppercase">Erreurs (24h)</p>
                    <p class="text-2xl font-bold text-red-400">0</p>
                </div>
            </div>

            <div class="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <h2 class="text-xl font-semibold mb-4 text-indigo-300">Configuration Active</h2>
                <div class="space-y-3">
                    <div class="flex justify-between p-3 bg-gray-700 rounded-lg">
                        <span>Provider par défaut :</span>
                        <span class="font-mono text-yellow-400 font-bold italic">Google Vision</span>
                    </div>
                    <div class="flex justify-between p-3 bg-gray-700 rounded-lg">
                        <span>Modèle de secours :</span>
                        <span class="font-mono text-gray-400">Gemini Pro Vision</span>
                    </div>
                </div>
            </div>
        </div>
    </body>
    </html>
  `);
});

export default admin;