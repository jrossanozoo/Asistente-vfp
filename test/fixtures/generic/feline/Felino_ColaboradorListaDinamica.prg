define class Felino_ColaboradorListaDinamica as ColaboradorListaDinamica of ColaboradorListaDinamica.prg

	#if .f.
		local this as Felino_ColaboradorListaDinamica of Felino_ColaboradorListaDinamica.prg
	#endif

	*-----------------------------------------------------------------------------------------
	protected function ObtenerConcepto( tcClave as String ) as String
		local lcRetorno as String
		do case
			case tcClave == "X.Y"
				lcRetorno = "XY"
			otherwise
				lcRetorno = dodefault( tcClave )
		endcase
		return lcRetorno
	endfunc

enddefine
