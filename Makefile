.PHONY: build test clean deploy

# Compile le smart contract en WASM
build-wasm:
	cd contracts/lending-controller && cargo build --target wasm32-unknown-unknown --release
	@echo "WASM output: contracts/lending-controller/target/wasm32-unknown-unknown/release/lending_controller.wasm"
	@ls -la contracts/lending-controller/target/wasm32-unknown-unknown/release/lending_controller.wasm

# Optimise le WASM (si wasm-opt est installé)
optimize-wasm: build-wasm
	wasm-opt -Os contracts/lending-controller/target/wasm32-unknown-unknown/release/lending_controller.wasm \
		-o contracts/lending-controller/target/wasm32-unknown-unknown/release/lending_controller_opt.wasm || \
		echo "wasm-opt not found, skipping optimization"

# Tests Rust
test-rust:
	cd contracts/lending-controller && cargo test

# Tests TypeScript
test-ts:
	cd sdk && npm test
	cd keeper && npm test

# Tout tester
test: test-rust test-ts

# Install dependencies
setup:
	cd sdk && npm install
	cd keeper && npm install

# Clean
clean:
	cd contracts/lending-controller && cargo clean
	rm -rf sdk/dist keeper/dist
