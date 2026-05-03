const { PrismaClient } = require('./node_modules/@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const count = await prisma.inverterConnection.count({ where: { isActive: true } });
  console.log('ACTIVE INVERTERS:', count);
  const all = await prisma.inverterConnection.findMany({ select: { id: true, isActive: true } });
  console.log('ALL:', JSON.stringify(all, null, 2));
  await prisma.$disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
