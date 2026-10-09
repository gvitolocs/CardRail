import XCTest
@testable import CardRails

final class CatalogIndexTests: XCTestCase {
    private let json = """
    {
      "version": 1,
      "model": {"name":"MiloCNN","onnxSha256":"abc","dim":128,"size":448,"dtype":"float16"},
      "catalogs": [
        {"id":"pokemon_western","game":"pokemon","languages":["EN","IT","FR","DE","ES","PT"],"count":26051,
         "embeddings":{"path":"pokemon_western/embeddings-aaa.f16","bytes":10,"sha256":"e1"},
         "cards":{"path":"pokemon_western/cards-aaa.json","bytes":20,"sha256":"c1"}},
        {"id":"pokemon_japanese","game":"pokemon","languages":["JP"],"count":1,
         "embeddings":{"path":"pokemon_japanese/embeddings-bbb.f16","bytes":10,"sha256":"e2"},
         "cards":{"path":"pokemon_japanese/cards-bbb.json","bytes":20,"sha256":"c2"}},
        {"id":"pokemon_chinese","game":"pokemon","languages":["ZH"],"count":1,
         "embeddings":{"path":"pokemon_chinese/embeddings-ccc.f16","bytes":10,"sha256":"e3"},
         "cards":{"path":"pokemon_chinese/cards-ccc.json","bytes":20,"sha256":"c3"}},
        {"id":"magic_all","game":"magic","languages":["*"],"count":1,
         "embeddings":{"path":"magic_all/embeddings-ddd.f16","bytes":10,"sha256":"e4"},
         "cards":{"path":"magic_all/cards-ddd.json","bytes":20,"sha256":"c4"}}
      ]
    }
    """

    private func decode() throws -> CatalogIndex {
        try JSONDecoder().decode(CatalogIndex.self, from: Data(json.utf8))
    }

    func testExactLanguage() throws {
        XCTAssertEqual(try decode().catalog(for: "pokemon", language: "JP")?.id, "pokemon_japanese")
    }

    func testLanguageFallsBackToFirstEntry() throws {
        XCTAssertEqual(try decode().catalog(for: "pokemon", language: "KO")?.id, "pokemon_western")
    }

    func testWildcardLanguage() throws {
        XCTAssertEqual(try decode().catalog(for: "magic", language: "IT")?.id, "magic_all")
    }

    func testUnknownGame() throws {
        XCTAssertNil(try decode().catalog(for: "chess", language: "EN"))
    }
}
