const express = require('express');
const oracledb = require('oracledb');
const cors = require('cors');

const app = express();
const PORT = 3000;


const oracleConfig = {
    user: 'BICICLETAS_APP',
    password: '123456',
    connectString: 'localhost/XEPDB1'
};

app.use('/qrs', express.static('public/qrs'));

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta: Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    const result = await connection.execute(
      `SELECT id_usuario, nombre, email, estado, administrador
       FROM Usuario
       WHERE email = :email AND contrasena = :password`,
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    const [id_usuario, nombre, emailDb, estado, administrador] = result.rows[0];

    res.json({
      usuario: {
        id_usuario,
        nombre,
        email: emailDb,
        estado,
        administrador
      }
    });

  } catch (error) {
    console.error('Error en /api/login:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  } finally {
    if (connection) await connection.close();
  }
});

// Ruta: Registro
app.post('/api/registro', async (req, res) => {
  const { nombre, apellido, correo, contrasena } = req.body;
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    await connection.execute(
      `INSERT INTO Usuario (id_usuario, nombre, email, estado, contrasena)
       VALUES (Usuario_seq.NEXTVAL, :nombre_apellido, :correo, 'activo', :contrasena)`,
      {
        nombre_apellido: `${nombre} ${apellido}`,
        correo,
        contrasena
      },
      { autoCommit: true }
    );

    res.json({ message: 'Usuario registrado exitosamente' });

  } catch (error) {
    console.error('Error en /api/registro:', error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  } finally {
    if (connection) await connection.close();
  }
});

// Ruta: Obtener datos del perfil por ID
app.get('/api/perfil/:id', async (req, res) => {
  const id = req.params.id;
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    const result = await connection.execute(
      `SELECT nombre, email, estado FROM Usuario WHERE id_usuario = :id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const [nombre, email, estado] = result.rows[0];

    res.json({ nombre, email, estado });

  } catch (error) {
    console.error('Error en /api/perfil:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  } finally {
    if (connection) await connection.close();
  }
});

const QRCode = require('qrcode');
const fs = require('fs');

app.post('/api/reservar', async (req, res) => {
  const { id_usuario, id_origen, id_destino } = req.body;
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);

    // Buscar bicicleta activa
    const biciResult = await connection.execute(
      `SELECT id_bicicleta FROM Bicicleta WHERE estado = 'activo' AND id_terminal = :id_origen FETCH FIRST 1 ROWS ONLY`,
      [id_origen]
    );

    if (biciResult.rows.length === 0) {
      return res.status(400).json({ error: 'No hay bicicletas disponibles.' });
    }

    const id_bicicleta = biciResult.rows[0][0];
    const codigo_desbloqueo = 'CODE' + Math.floor(1000 + Math.random() * 9000);

    // ✅ Generar código QR
    const qrText = `Reserva confirmada\nUsuario: ${id_usuario}\nBicicleta: ${id_bicicleta}\nCódigo: ${codigo_desbloqueo}`;
    const qrFileName = `qr_${Date.now()}.png`;
    const qrPath = `./public/qrs/${qrFileName}`;
    await QRCode.toFile(qrPath, qrText);

    // Insertar reserva
    await connection.execute(
      `INSERT INTO Reserva (id_reserva, fecha_inicio, estado, codigo_desbloqueo, id_usuario, id_bicicleta)
       VALUES (Reserva_seq.NEXTVAL, SYSDATE, 'activa', :codigo, :id_usuario, :id_bicicleta)`,
      { codigo: codigo_desbloqueo, id_usuario, id_bicicleta },
      { autoCommit: false }
    );

    // Obtener ID de la reserva recién creada
    const idReservaResult = await connection.execute(
      `SELECT MAX(id_reserva) FROM Reserva WHERE id_usuario = :id_usuario`,
      [id_usuario]
    );
    const id_reserva = idReservaResult.rows[0][0];

    // Guardar la ruta del QR en la base de datos
    await connection.execute(
      `UPDATE Reserva SET qr_path = :qrPath WHERE id_reserva = :id`,
      { qrPath: `qrs/${qrFileName}`, id: id_reserva },
      { autoCommit: false }
    );

    // Cambiar estado de la bicicleta
    await connection.execute(
      `UPDATE Bicicleta SET estado = 'reservada' WHERE id_bicicleta = :id_bicicleta`,
      [id_bicicleta],
      { autoCommit: false }
    );

    // Restar disponibilidad en la terminal
    await connection.execute(
      `UPDATE Terminal SET bicicletas_disponibles = bicicletas_disponibles - 1 WHERE id_terminal = :id_origen`,
      [id_origen],
      { autoCommit: true }
    );

    // Respuesta final
    res.json({
      message: 'Reserva confirmada',
      codigo_desbloqueo,
      qr_filename: qrFileName,
      qr_path: `qrs/${qrFileName}`,
      id_reserva
    });

  } catch (error) {
    console.error('Error en /api/reservar:', error);
    res.status(500).json({ error: 'Error al procesar la reserva' });
  } finally {
    if (connection) await connection.close();
  }
});

app.post('/api/devolver', async (req, res) => {
    const { id_usuario } = req.body;
    let connection;

    try {
        connection = await oracledb.getConnection(oracleConfig);

        // Buscar reserva activa del usuario
        const reservaResult = await connection.execute(
            `SELECT id_reserva, id_bicicleta, fecha_inicio
             FROM Reserva
             WHERE id_usuario = :id_usuario AND estado = 'activa'`,
            [id_usuario]
        );

        if (reservaResult.rows.length === 0) {
            return res.status(400).json({ error: 'No tienes ninguna bicicleta activa para devolver.' });
        }

        const [id_reserva, id_bicicleta, fecha_inicio] = reservaResult.rows[0];

        // Obtener terminal de la bicicleta
        const bicicletaResult = await connection.execute(
            `SELECT id_terminal FROM Bicicleta WHERE id_bicicleta = :id_bicicleta`,
            [id_bicicleta]
        );

        if (bicicletaResult.rows.length === 0) {
            return res.status(400).json({ error: 'No se encontró la bicicleta asociada.' });
        }

        const id_origen = bicicletaResult.rows[0][0];

        // Cambiar estado de la reserva a completada
        await connection.execute(
            `UPDATE Reserva SET estado = 'completada', fecha_fin = SYSDATE WHERE id_reserva = :id_reserva`,
            [id_reserva],
            { autoCommit: false }
        );

        // Cambiar estado de la bicicleta a activa
        await connection.execute(
            `UPDATE Bicicleta SET estado = 'activo' WHERE id_bicicleta = :id_bicicleta`,
            [id_bicicleta],
            { autoCommit: false }
        );

        // Sumar 1 a bicicletas_disponibles del terminal origen
        await connection.execute(
            `UPDATE Terminal SET bicicletas_disponibles = bicicletas_disponibles + 1 WHERE id_terminal = :id_origen`,
            [id_origen],
            { autoCommit: false }
        );

        // Insertar en Historial
        await connection.execute(
            `INSERT INTO Historial (id_historial, id_usuario, id_bicicleta, fecha_inicio, fecha_fin, descripcion, reporte)
             VALUES (Historial_seq.NEXTVAL, :id_usuario, :id_bicicleta, :fecha_inicio, SYSDATE, 'Viaje completado', '-')`,
            { id_usuario, id_bicicleta, fecha_inicio },
            { autoCommit: true }
        );

        res.json({ message: 'Bicicleta devuelta correctamente', id_bicicleta });

    } catch (error) {
        console.error('Error en /api/devolver:', error);
        res.status(500).json({ error: 'Error al devolver la bicicleta' });
    } finally {
        if (connection) await connection.close();
    }
});

app.get('/api/historial/:id_usuario', async (req, res) => {
    const { id_usuario } = req.params;
    let connection;

    try {
        connection = await oracledb.getConnection(oracleConfig);

        const result = await connection.execute(
            `SELECT h.id_bicicleta,
                    NVL(h.descripcion, '-') AS descripcion,
                    TO_CHAR(h.fecha_inicio, 'YYYY-MM-DD HH24:MI') AS fecha_inicio,
                    TO_CHAR(h.fecha_fin, 'YYYY-MM-DD HH24:MI') AS fecha_fin,
                    NVL(h.reporte, '-') AS reporte
             FROM Historial h
             WHERE h.id_usuario = :id_usuario
             ORDER BY h.fecha_inicio DESC`,
            [id_usuario]
        );

        const historial = result.rows.map(row => ({
            numero_bicicleta: row[0],
            descripcion: row[1],
            fecha_inicio: row[2],
            fecha_fin: row[3],
            reporte: row[4]
        }));

        res.json({ historial });

    } catch (error) {
        console.error('Error en /api/historial:', error);
        res.status(500).json({ error: 'Error al obtener el historial' });
    } finally {
        if (connection) await connection.close();
    }
});

app.post('/api/reporte', async (req, res) => {
    const { id_usuario, id_bicicleta, descripcion } = req.body;
    let connection;

    try {
        connection = await oracledb.getConnection(oracleConfig);

        //Insertar el nuevo reporte
        await connection.execute(
            `INSERT INTO Reporte (id_reporte, descripcion, fecha_reporte, estado, id_bicicleta, id_usuario)
             VALUES (Reporte_seq.NEXTVAL, :descripcion, SYSDATE, 'pendiente', :id_bicicleta, :id_usuario)`,
            { descripcion, id_bicicleta, id_usuario },
            { autoCommit: false }
        );

        // Contar reportes pendientes para la bicicleta
        const result = await connection.execute(
            `SELECT COUNT(*) FROM Reporte WHERE id_bicicleta = :id_bicicleta AND estado = 'pendiente'`,
            [id_bicicleta]
        );

        const conteo_pendientes = result.rows[0][0];

        // Actualizar estado de la bicicleta según conteo
        const nuevo_estado = conteo_pendientes > 3 ? 'inactivo' : 'activo';

        await connection.execute(
            `UPDATE Bicicleta SET estado = :nuevo_estado WHERE id_bicicleta = :id_bicicleta`,
            { nuevo_estado, id_bicicleta },
            { autoCommit: true }
        );

        res.json({ message: 'Reporte enviado exitosamente' });

    } catch (error) {
        console.error('Error en /api/reporte:', error);
        res.status(500).json({ error: 'Error al enviar el reporte' });
    } finally {
        if (connection) await connection.close();
    }
});


// Obtener todas las bicicletas
app.get('/api/bicicletas', async (req, res) => {
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        const result = await connection.execute(
            `SELECT id_bicicleta, modelo, estado, ubicacion FROM Bicicleta`
        );
        const bicicletas = result.rows.map(r => ({
            id_bicicleta: r[0],
            modelo: r[1],
            estado: r[2],
            ubicacion: r[3]
        }));
        res.json(bicicletas);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener bicicletas' });
    } finally {
        if (connection) await connection.close();
    }
});

// Agregar bicicleta
app.post('/api/bicicletas', async (req, res) => {
    const { modelo, ubicacion } = req.body;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `INSERT INTO Bicicleta (id_bicicleta, modelo, estado, ubicacion) VALUES (Bicicleta_seq.NEXTVAL, :modelo, 'activo', :ubicacion)`,
            { modelo, ubicacion },
            { autoCommit: true }
        );
        res.json({ message: 'Bicicleta agregada' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al agregar bicicleta' });
    } finally {
        if (connection) await connection.close();
    }
});

// Editar bicicleta
app.put('/api/bicicletas/:id', async (req, res) => {
    const { id } = req.params;
    const { modelo, ubicacion, estado } = req.body;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `UPDATE Bicicleta SET modelo = :modelo, ubicacion = :ubicacion, estado = :estado WHERE id_bicicleta = :id`,
            { modelo, ubicacion, estado, id },
            { autoCommit: true }
        );
        res.json({ message: 'Bicicleta actualizada' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar bicicleta' });
    } finally {
        if (connection) await connection.close();
    }
});

// Eliminar bicicleta
app.delete('/api/bicicletas/:id', async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `DELETE FROM Bicicleta WHERE id_bicicleta = :id`,
            [id],
            { autoCommit: true }
        );
        res.json({ message: 'Bicicleta eliminada' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar bicicleta' });
    } finally {
        if (connection) await connection.close();
    }
});
// Obtener todos los reportes
app.get('/api/reportes', async (req, res) => {
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        const result = await connection.execute(
            `SELECT r.id_reporte, u.nombre, TO_CHAR(r.fecha_reporte, 'YYYY-MM-DD HH24:MI'), r.descripcion, r.estado
             FROM Reporte r
             JOIN Usuario u ON r.id_usuario = u.id_usuario`
        );
        const reportes = result.rows.map(r => ({
            id_reporte: r[0],
            usuario: r[1],
            fecha: r[2],
            descripcion: r[3],
            estado: r[4]
        }));
        res.json(reportes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al obtener reportes' });
    } finally {
        if (connection) await connection.close();
    }
});

// Editar reporte (cambiar estado)
app.put('/api/reportes/:id', async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `UPDATE Reporte SET estado = :estado WHERE id_reporte = :id`,
            { estado, id },
            { autoCommit: true }
        );
        res.json({ message: 'Reporte actualizado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar reporte' });
    } finally {
        if (connection) await connection.close();
    }
});

// Eliminar reporte
app.delete('/api/reportes/:id', async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `DELETE FROM Reporte WHERE id_reporte = :id`,
            [id],
            { autoCommit: true }
        );
        res.json({ message: 'Reporte eliminado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar reporte' });
    } finally {
        if (connection) await connection.close();
    }
});
// Obtener todos los usuarios
app.get('/api/usuarios', async (req, res) => {
  let connection;

  try {
    connection = await oracledb.getConnection(oracleConfig);
    const result = await connection.execute(
      `SELECT id_usuario, nombre, email, estado, administrador FROM Usuario`
    );

    const usuarios = result.rows.map(row => ({
      id_usuario: row[0],
      nombre: row[1],
      email: row[2],
      estado: row[3],
      administrador: row[4]
    }));

    res.json(usuarios);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  } finally {
    if (connection) await connection.close();
  }
});


// Editar usuario (cambiar estado)
app.put('/api/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { estado, administrador } = req.body;
  let connection;
  try {
    connection = await oracledb.getConnection(oracleConfig);
    await connection.execute(
      `UPDATE Usuario SET estado = :estado, administrador = :admin WHERE id_usuario = :id`,
      { estado, admin: administrador, id },
      { autoCommit: true }
    );
    res.json({ message: 'Usuario actualizado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  } finally {
    if (connection) await connection.close();
  }
});


// Eliminar usuario
app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    let connection;
    try {
        connection = await oracledb.getConnection(oracleConfig);
        await connection.execute(
            `DELETE FROM Usuario WHERE id_usuario = :id`,
            [id],
            { autoCommit: true }
        );
        res.json({ message: 'Usuario eliminado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al eliminar usuario' });
    } finally {
        if (connection) await connection.close();
    }
});




// Inicio del servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://ecorideprfinal.lat:${PORT}`);
});
