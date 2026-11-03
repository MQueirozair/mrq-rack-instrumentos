//! Gera um arquivo `.npno` sintético, 100% real no sentido de que passa pelo
//! codificador de verdade do `nord-format` (mesma lib que o Rack usa para decodificar),
//! só que com conteúdo gerado (senoides) em vez de uma amostra comercial da Clavia —
//! não temos acesso a uma biblioteca de piano Nord licenciada para testar, então isso
//! serve de "arquivo de prova" ponta a ponta: carregar no Rack, tocar pelo teclado
//! MIDI e ouvir as notas certas saindo pelas teclas certas confirma que o decodificador
//! wasm (mesmo crate, outra face) está funcionando de verdade, não só compilando.
use nord_format::formats::npno::codec::RATE;
use nord_format::formats::npno::encode::{build, Donor, Kind, Options, Recording, Rules};
use nord_format::formats::npno::Bank;
use std::io::Cursor;

fn sine_i16(freq_hz: f64, seconds: f64, amplitude: f64) -> Vec<i16> {
    let n = (RATE as f64 * seconds) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / RATE as f64;
            let v = (2.0 * std::f64::consts::PI * freq_hz * t).sin() * amplitude;
            v as i16
        })
        .collect()
}

fn midi_to_freq(note: u8) -> f64 {
    440.0 * 2f64.powf((note as f64 - 69.0) / 12.0)
}

fn main() {
    // três raízes gravadas: C3 (48), C4 (60), C5 (72); cada uma com duas camadas de
    // velocidade (0 = forte, 20 = fraca) pra testar a seleção de camada por
    // velocidade, e uma nota de "release" curta pra C4.
    let roots = [48u8, 60u8, 72u8];
    let mut recordings = Vec::new();
    for &root in &roots {
        let freq = midi_to_freq(root);
        recordings.push(Recording {
            root,
            bank: Bank::Attack,
            layer: 0,
            channels: vec![sine_i16(freq, 1.2, 9000.0)],
        });
        recordings.push(Recording {
            root,
            bank: Bank::Attack,
            layer: 20,
            channels: vec![sine_i16(freq, 1.2, 3000.0)],
        });
    }
    recordings.push(Recording {
        root: 60,
        bank: Bank::Release,
        layer: 0,
        channels: vec![sine_i16(midi_to_freq(60) * 2.0, 0.25, 2000.0)],
    });

    let donor = Donor::Rules(Rules::new(Kind::Grand));
    let options = Options::new("MRQ Test").variant("E2E");
    let library = build(&donor, &options, &recordings).expect("build deve funcionar");

    let piano = library.to_piano().expect("to_piano deve funcionar");
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        piano.write_to(&mut cursor).expect("write_to deve funcionar");
    }

    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "synthetic-test-piano.npno".to_string());
    std::fs::write(&out_path, &buf).expect("escrever o arquivo");
    eprintln!("gravado {} bytes em {}", buf.len(), out_path);
}
