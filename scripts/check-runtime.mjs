if (Number(process.versions.node.split(".")[0]) !== 24) {
  console.error(
    "Нужен Node.js 24. Выполните nvm use перед установкой и запуском.",
  );
  process.exit(1);
}
