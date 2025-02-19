import dgram from 'dgram';
import ModbusRTU from "modbus-serial";

const mbsId: number = 1;
const mbsPort: number = 1502;
const mbsHost: string = "192.168.1.161";
const mbsTimeout: number = 2000;

const advancedPwrControlEn = 61762;
const activePowerLimit = 61441;
const commitPowerControl = 61696;

const deadBand = 5;

const client = new ModbusRTU();

const connectClient = async (): Promise<void> => {
    await client.close();

    client.setID(mbsId);
    client.setTimeout(mbsTimeout);

    try {
        await client.connectTCP(mbsHost, { port: mbsPort });
    } catch (e) {
        console.log(e);
    }
};

const writeRegisterAsync = async (unitId: number, register: number, value: number): Promise<any> => {
  return new Promise((resolve, reject) => {
    try {
      client.writeFC6(unitId, register, value, (err, data) => {
          if (err) {
              //console.log(err);
              reject(err);
          } else {
              //console.log(data);
              resolve(data);
          }
      });
    } catch (e) {
      console.log(`exceptoni in writeRegisterAsync ${e}`);
      //console.log(e);
      //reject(e);
    }
  });
};

const run = async (): Promise<void> => {
  await connectClient();

  const maxPower = await readFloatRegister(0xF304);
  console.log(`Max Active Power: ${maxPower}`);

  await writeRegisterValues(advancedPwrControlEn, [0,1]);
  console.log(`set Advanced Power Control On`);

  // Define the multicast address and port (replace with actual values)
  const MULTICAST_ADDR = '239.12.255.254';
  const MULTICAST_PORT = 9522;
  const MAX_EXPORT = 6500;
  const INVERTER_POWER = 7000;

  var lastPersentage = 0;

  const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Join the multicast group
  server.on('listening', async () => {
    const address = server.address();
    // console.log(`Listening on ${address.address}:${address.port}`);
    server.addMembership(MULTICAST_ADDR);
  });

  // Handle incoming UDP messages
  server.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    // console.log(`Received message from ${rinfo.address}:${rinfo.port}`);
    
    // The msg is a buffer containing the UDP packet
    // You would need to parse the buffer based on the protocol of Sunny Home Manager
    // For example, you can log the raw data as a buffer first to inspect it
    // console.log(msg);

    // Example of parsing the binary data (this will vary based on actual packet format)
    // You may need to decode this depending on the specific structure of the Home Manager's UDP packet
    try {
      const length = msg.length;

      if (length === 608) {
        const meter = msg.readUInt32BE(28);
        const consumption = msg.readUInt32BE(32);
        const production = msg.readUInt32BE(52);
        
        if (meter === 66560) {
          const timestamp = new Date();
          const t = timestamp.toISOString().split('.')[0];
          const d = timestamp.getDate();
          const h = timestamp.getHours();
          const m = timestamp.getMinutes();
          const s = timestamp.getSeconds();
          const ms = timestamp.getMilliseconds();

          const overProduction = production / 10 - MAX_EXPORT;
          //console.log(`production: ${production} overProduction: ${overProduction}`);

          const desiredProduction = INVERTER_POWER - overProduction;
          const desiredPersentage = Math.floor(desiredProduction / INVERTER_POWER * 100);
          const controlPersentage = Math.min(Math.max(desiredPersentage, 0), 100);
          if (
            ((controlPersentage < lastPersentage) && lastPersentage - controlPersentage > deadBand) ||
            ((lastPersentage < controlPersentage) && controlPersentage - lastPersentage > deadBand)) {
            lastPersentage = controlPersentage;
            console.log(`Setting inverter to ${controlPersentage}%`);
            await writeRegisterAsync(1, activePowerLimit, controlPersentage);
            client.setTimeout(5000);
            await writeRegisterAsync(1, commitPowerControl, 1)
            client.setTimeout(mbsTimeout);
          };

          //console.log(`${d}\t${h}:${m}:${s}.${ms}\t${-consumption / 10}\t${production / 10}`);        
          console.log(`${t}\t${-consumption / 10}\t${production / 10}\t${overProduction}\t${desiredPersentage}%`);
        }
      }
    } catch (err) {
      //console.log('Error parsing data:', err);
    }
  });

  // Handle errors
  server.on('error', (err: Error) => {
    console.log(`Server error:\n${err.stack}`);
    server.close();
  });

  // Bind to the UDP port and listen for packets
  server.bind(MULTICAST_PORT, () => {
    console.log(`Server is bound to port ${MULTICAST_PORT}`);
  });
};

const readFloatRegister = async (r: number): Promise<Number> => {
  try {
      const data = await client.readHoldingRegisters(r, 2);
      if (data.buffer.length === 4) {
          return bufferToFloat32(data.buffer);
      }
  } catch (e) {
      console.log(e);
  }
  return Number.NaN;
};

const bufferToFloat32 = (buffer: Buffer): number => {
  const arrayBuffer = new ArrayBuffer(4);
  const view = new DataView(arrayBuffer);

  // Assuming little-endian word order (LSB-MSB)
  view.setUint16(0, buffer.readUInt16BE(0), true);
  view.setUint16(2, buffer.readUInt16BE(2), true);

  return view.getFloat32(0, true);
};

const writeRegisterValues = async (register: number, values: Array<number>): Promise<void> => {
  try {
      await client.writeRegisters(register, values);
      console.log(`Successfully wrote to register ${register}`);
  } catch (e) {
      console.log(e);
  }
};

run();