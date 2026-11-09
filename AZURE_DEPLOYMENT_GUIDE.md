# Guia Completa d'Arquitectura, Connexió del PoC i Desplegament a Azure for Students — QuietVenue IoT

Aquest projecte implementa de punta a punta el sistema **QuietVenue / QuietBar** combinant la implementació física del **Proof of Concept (`Report 1 bo.pdf`: Nordic nRF52840-DK + Grove Sound Sensor v1.0 + MPU-6050 -> BLE -> Arduino UNO Q 4GB)** amb els **2 FrontEnds en temps real** i el **Backend Cloud** pensat per a **Azure for Students**.

---

## 1. Què cal allotjar a Azure for Students?

Amb el compte d'**Azure for Students** (que inclou 100 $ de crèdit anual i serveis gratuïts), tens dues arquitectures ideals per allotjar el vostre sistema:

### Opció Recomanada A (Més senzilla i completa per a IoT): **Azure Virtual Machine (Ubuntu Server B1s / B2s)**
És l'opció més pràctica quan teniu tant HTTP/WebSockets com MQTT (segons el vostre diagrama `Quiet_Architecture.png`), perquè permet obrir tant el port web (`80`/`443`/`4000`) com el port TCP natiu de **MQTT (`1883`)** en una sola màquina gratuïta amb el crèdit d'estudiant:
1. **El Backend Node.js (`backend/`)**:
   - Actua simultàniament com a **Broker MQTT (`port 1883`)**, **Servidor d'Ingesta HTTP REST (`POST /api/telemetry`)**, **Motor de Regles i Llindars d'Avís/Alerta**, i **Servidor WebSockets (`Socket.IO`)** en temps real.
2. **Els 2 FrontEnds (`frontend-bar/` i `frontend-ajuntament/`)**:
   - Es poden servir des de la mateixa VM (amb Nginx o PM2) o allotjar-se gratuïtament a **Azure Static Web Apps**.

### Opció Recomanada B (100% PaaS Serverless d'Azure): **Azure App Service + Azure Static Web Apps**
Si preferiu no administrar cap màquina virtual Linux:
1. **Azure App Service (Pla Free F1 o Basic B1 — Node.js 20 LTS)**:
   - Allotja la carpeta `backend/`.
   - Activa l'opció **WebSockets = ON** a la configuració de l'App Service perquè `Socket.IO` funcioni en temps real.
   - L'Arduino UNO Q (o l'script pont `edge-bridge/serial_to_azure_bridge.py`) hi envia les lectures del sensor en temps real per HTTPS (`POST https://<el-teu-backend>.azurewebsites.net/api/telemetry`).
2. **2 recursos d'Azure Static Web Apps (Pla Free)**:
   - **Static Web App 1 (`frontend-bar`)**: URL per als treballadors i responsables dels bars.
   - **Static Web App 2 (`frontend-ajuntament`)**: URL per als tècnics de l'Ajuntament de Molins de Rei.

---

## 2. Pas a Pas per Desplegar a Azure for Students

### Pas 1: Desplegar el Backend a Azure App Service (o Azure VM)
1. Entra a [portal.azure.com](https://portal.azure.com) amb el teu correu universitari (`@autonoma.cat`).
2. Cerca **App Services** -> **Create** -> **Web App**:
   - **Subscription**: *Azure for Students*
   - **Resource Group**: Crea `rg-quietvenue-iot`
   - **Name**: `quietvenue-backend-uab` (la teva URL serà `https://quietvenue-backend-uab.azurewebsites.net`)
   - **Runtime stack**: `Node 20 LTS`
   - **Operating System**: `Linux`
   - **Pricing Plan**: `Free F1` o `Basic B1` (inclòs al crèdit d'estudiant).
3. Un cop creat el Web App, ves al menú lateral **Configuration -> General settings**:
   - Posa **Web sockets** a **On** i clica **Save**.
4. Desplega la carpeta `backend/` des de VS Code (amb l'extensió *Azure App Service* clicant *Deploy to Web App...* sobre la carpeta `backend`) o amb Azure CLI:
   ```bash
   cd backend
   az webapp up --name quietvenue-backend-uab --resource-group rg-quietvenue-iot --runtime "NODE:20-lts"
   ```

### Pas 2: Desplegar els 2 FrontEnds a Azure Static Web Apps
Abans de compilar cada FrontEnd per a Azure, defineix la variable d'entorn `VITE_BACKEND_URL` apuntant a la URL del teu backend d'Azure (`https://quietvenue-backend-uab.azurewebsites.net`):

1. **Per al FrontEnd 1 (`frontend-bar`)**:
   - Crea un fitxer `.env.production` dins de `frontend-bar/`:
     ```env
     VITE_BACKEND_URL=https://quietvenue-backend-uab.azurewebsites.net
     ```
   - Executa `npm run build` dins de `frontend-bar/` (generarà la carpeta `dist/`).
   - Al Portal d'Azure -> **Static Web Apps** -> **Create** (`quietvenue-bar-ui`) o puja la carpeta `dist/` amb l'extensió *Azure Static Web Apps* de VS Code.

2. **Per al FrontEnd 2 (`frontend-ajuntament`)**:
   - Crea un fitxer `.env.production` dins de `frontend-ajuntament/`:
     ```env
     VITE_BACKEND_URL=https://quietvenue-backend-uab.azurewebsites.net
     ```
   - Executa `npm run build` dins de `frontend-ajuntament/` i desplega la carpeta `dist/` a una segona Static Web App (`quietvenue-ajuntament-ui`).

---

## 3. Com Connectar el PoC Físic (`nRF52840-DK` + `Arduino UNO Q`) en Temps Real

El teu codi actual de la placa **Nordic nRF52840-DK** (`QuietBar_IoT-main/src/main.c`) llegeix:
- **Micròfon Grove v1.0 (ADC `0..4095`)** a l'atribut GATT `12345678-1234-5678-1234-56789abcdef1` (`sound_level_val`).
- **Acceleròmetre MPU-6050 (`m/s² * 100`)** a l'atribut GATT `12345678-1234-5678-1234-56789abcdef2` (`accel_magnitude_val`).

I l'**Arduino UNO Q** (`iot_conn_ble.ino`) s'hi subscriu per BLE i escriu pel port Sèrie:
```text
[SOROLL GROVE] Amplitud ADC: 45
Vibració: 2.35 m/s2
```

Per veure aquestes dades en temps real als 2 FrontEnds (sense ni tan sols haver de reprogramar la nRF52840 ni l'Arduino):

1. Endolla la **nRF52840-DK** i l'**Arduino UNO Q** per USB.
2. Verifica en quin port COM està l'Arduino UNO Q (ex: `COM3` o `COM5` al Gestor de Dispositius de Windows).
3. Obre una terminal a la carpeta `edge-bridge/` i executa:
   ```bash
   pip install pyserial
   python serial_to_azure_bridge.py --port COM3 --url http://localhost:4000
   ```
   *(O si ja ho tens a Azure: `--url https://quietvenue-backend-uab.azurewebsites.net`)*

A l'instant:
- El Backend detectarà `source: "hardware_live"`, desactivarà l'auto-demo sobre la **Taula 1 (PoC Real)** i mostrarà el badge verd **"PoC Físic Connectat"**.
- Quan parlis fort prop del micròfon Grove o moguis/arrosseguis la taula amb l'MPU-6050, veuràs pujar la corba d'ADC i de `m/s²` en temps real al **Dashboard del Bar**, s'il·luminarà el mapa de calor de la **Taula 1** i s'actualitzarà el **Mapa de Calor de Molins de Rei** al **Dashboard de l'Ajuntament**!
