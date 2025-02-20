import dgram from 'dgram';
import ModbusRTU from "modbus-serial";

const mbsId: number = 1;
const mbsPort: number = 1502;
const mbsHost: string = "192.168.1.161";
const mbsTimeout: number = 2000;

const advancedPwrControlEn = 61762;
const activePowerLimit = 61441;
const commitPowerControl = 61696;

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
  const MAX_PRODUCTION = 6600;
  const INVERTER_CONTROL = 5000; // production over this level controls lowers production, else allow 100%
  const INVERTER_POWER = 7400;

  const deadBand = 2; //ignores ripple in the control signal
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
        const powerImport = msg.readUInt32BE(32) * 0.1;
        //const powerImportFilterd = movingAverageFilter(powerImport);
        const powerExport = msg.readUInt32BE(52) * 0.1;
        const production = powerExport - powerImport;
        
        if (meter === 66560) {
          const timestamp = new Date();
          const t = timestamp.toISOString().split('.')[0];
          const d = timestamp.getDate();
          const h = timestamp.getHours();
          const m = timestamp.getMinutes();
          const s = timestamp.getSeconds();
          const ms = timestamp.getMilliseconds();

          const overProduction = production - MAX_PRODUCTION;
          //console.log(`powerExport: ${powerExport / 10} overProduction: ${overProduction}`);

          const inverterPower = (await client.readHoldingRegisters(40083, 1)).data[0];
          //console.log(`inverterPower: ${inverterPower} power of MAX: ${inverterPower/INVERTER_POWER}`);

          const desiredPower = inverterPower - overProduction;
          //console.log(`desiredProduction: ${desiredProduction}`);

          const desiredPersentage = Math.round(desiredPower / INVERTER_POWER * 100);
          //console.log(`desiredPersentage %: ${desiredPersentage}`);

          const controlPersentage = Math.min(Math.max(desiredPersentage, 0), 100);
          if ( production > INVERTER_CONTROL && (
            (controlPersentage < lastPersentage) ||
            //((controlPersentage < lastPersentage) && lastPersentage - controlPersentage > deadBand) ||
            ((lastPersentage < controlPersentage) && controlPersentage - lastPersentage > deadBand)
            )) {
            lastPersentage = controlPersentage;

            const powerControlOn = (await client.readHoldingRegisters(61762, 2)).data[1];
            if (powerControlOn === 0) {
                await writeRegisterValues(61762, [0, 1]);
                console.log(`Enabled Advanced Power Control`);
            }

            console.log(`Setting inverter to ${controlPersentage}%`);
            await writeRegisterAsync(1, activePowerLimit, controlPersentage);

            // commitPowerControl not needed?
            //await writeRegisterAsync(1, commitPowerControl, 1)
          };

          //console.log(`${d}\t${h}:${m}:${s}.${ms}\t${-consumption / 10}\t${production / 10}`);        
          //console.log(`${t}\t${(-powerImport).toFixed(1)}\t${(-powerImportFilterd).toFixed(1)}\t${powerExport.toFixed(1)}\t${inverterPower.toFixed(1)}\t${overProduction}\t${controlPersentage}%`);
          console.log(`${t}\t${(-powerImport).toFixed(1)}\t${powerExport.toFixed(1)}\t${inverterPower.toFixed(1)}\t${overProduction}\t${controlPersentage}%`);
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

var xm1 = 0, xm2 = 0, xm3 = 0;
var ym1 = 0, ym2 = 0, ym3 = 0;
const butterworthFilter = (x: number): number => {
  // const a0 = 0.01809893300751445;
  // const a1 = 0.05429679902254335;
  // const a2 = 0.05429679902254335;
  // const a3 = 0.01809893300751445;
  // const b1 = -1.760041880343169;
  // const b2 = 1.182893262037831;
  // const b3 = -0.278059917634546;

  // const a0 = 0.098531160923;
  // const a1 = 0.295593482769;
  // const a2 = 0.295593482769;
  // const a3 = 0.098531160923;
  // const b1 = -0.577240524806;
  // const b2 = 0.421787048689;
  // const b3 = -0.056297236491;

  // const a0 = 0.01809893300751445;
  // const a1 = 0.05429679902254335;
  // const a2 = 0.05429679902254335;
  // const a3 = 0.01809893300751445;
  // const b1 = -1.760041880343169;
  // const b2 = 1.182893262037831;
  // const b3 = -0.278059917634546;

  // const a0 = 0.03258; 
  // const a1 = 0.09776; 
  // const a2 = 0.09776; 
  // const a3 = 0.03258; 
  // const b1 = -1.55424; 
  // const b2 = 1.09540; 
  // const b3 = -0.28035;

  const a0 = 0.0285; 
  const a1 = 0.0855; 
  const a2 = 0.0855; 
  const a3 = 0.0285; 
  const b1 = -1.6245; 
  const b2 = 1.1228; 
  const b3 = -0.2913; 


  const y = a0 * x + a1 * xm1 + a2 * xm2 + a3 * xm3 - b1 * ym1 - b2 * ym2 - b3 * ym3;

  xm3 = xm2;
  xm2 = xm1;
  xm1 = x;

  ym3 = ym2;
  ym2 = ym1;
  ym1 = y;

  return y;
};

const besselFilter = (x: number): number => {
  // 3rd-order Bessel filter coefficients (0.2π cutoff, unit gain)
  const a0 = 0.003621; 
  const a1 = 0.010863; 
  const a2 = 0.010863; 
  const a3 = 0.003621; 
  const b1 = -2.2997; 
  const b2 = 1.7925; 
  const b3 = -0.4403; 

  const y = a0 * x + a1 * xm1 + a2 * xm2 + a3 * xm3 - b1 * ym1 - b2 * ym2 - b3 * ym3;

  // Update states
  xm3 = xm2; xm2 = xm1; xm1 = x;
  ym3 = ym2; ym2 = ym1; ym1 = y;

  return y;
};

var xm1 = 0, xm2 = 0;

const movingAverageFilter = (x: number): number => {
  // 3-sample moving average (unit gain, no overshoot)
  const y = (x + xm1 + xm2) / 3; 

  // Update states
  xm2 = xm1;
  xm1 = x;

  return y;
};

run();